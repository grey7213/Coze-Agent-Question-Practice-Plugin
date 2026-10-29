/* 自动登录测试：真实加载扩展，验证登录表单识别、填写、防误触。

   用法: node tests/run-login.js
*/
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

const WEB_PORT = 8129;
const CDP_PORT = 9339;
const TMP = path.join(os.tmpdir(), 'cah-login');
const EXT = path.join(TMP, 'ext');
const PROFILE = path.join(TMP, 'profile');

// 测试用凭据（假数据，不是真实账号）
const TEST_ID = '20240001'; // 假学号，不是真实账号
const TEST_NAME = '测试姓名';

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (['tests', 'tools', 'specs', 'output', '.git'].includes(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

function buildExt() {
  fs.rmSync(TMP, { recursive: true, force: true });
  copyDir(ROOT, EXT);
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  mf.host_permissions = ['http://127.0.0.1/*'];
  mf.content_scripts[0].matches.push('http://127.0.0.1/*');
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));
}

function serve() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, p === '/' ? '/tests/mock-login.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) {
      console.log('  [404]', p, '->', f);
      res.writeHead(404); res.end('nf'); return;
    }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', () => r(server)));
}

const getJson = (u) => new Promise((resolve, reject) => http.get(u, (x) => {
  let d = '';
  x.on('data', (c) => (d += c));
  x.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
}).on('error', reject));

async function waitJson(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { return await getJson(url); } catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('等待超时: ' + url);
}

async function openWs(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const c = { id: 0, pending: new Map() };
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && c.pending.has(m.id)) {
      const { resolve, reject } = c.pending.get(m.id);
      c.pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  });
  c.send = (method, params) => new Promise((resolve, reject) => {
    const id = ++c.id;
    c.pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
  return c;
}

async function evaluate(cli, expr) {
  const r = await cli.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
}

async function cleanup(dir) {
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; }
    catch (e) { await new Promise((r) => setTimeout(r, 400)); }
  }
}

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  };

  buildExt();
  const server = await serve();
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    '--remote-debugging-port=' + CDP_PORT,
    '--user-data-dir=' + PROFILE,
    'about:blank'
  ], { stdio: 'ignore' });

  try {
    const ver = await waitJson('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const browser = await openWs(ver.webSocketDebuggerUrl);
    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT });
    console.log('扩展 id =', extId);

    const { targetId: optId } = await browser.send('Target.createTarget', {
      url: 'chrome-extension://' + extId + '/src/options/options.html'
    });
    let opt;
    for (let i = 0; i < 40; i++) {
      const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      opt = ts.find((x) => x.id === optId);
      if (opt) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const optPage = await openWs(opt.webSocketDebuggerUrl);
    await optPage.send('Runtime.enable');
    await new Promise((r) => setTimeout(r, 600));

    check('设置页有自动登录字段', await evaluate(optPage, '!!document.getElementById("loginStudentId") && !!document.getElementById("autoLogin")'));

    const base = {
      provider: 'anthropic', baseUrl: 'https://example.invalid', apiKey: 'x', model: 'm',
      autoGenerate: true, autoFill: true, requireConfirm: true, autoAdvance: false,
      stabilizeMs: 300, actionDelayMs: 50, maxRounds: 10,
      overrides: { messageList: '', input: '', sendButton: '' }
    };

    const openLoginPage = async (suffix) => {
      const { targetId } = await browser.send('Target.createTarget', {
        url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-login.html' + (suffix || '')
      });
      let t;
      for (let i = 0; i < 40; i++) {
        const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
        t = ts.find((x) => x.id === targetId);
        if (t && /mock-login/.test(t.url)) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      const page = await openWs(t.webSocketDebuggerUrl);
      await page.send('Runtime.enable');
      await new Promise((r) => setTimeout(r, 2200));
      return page;
    };

    // 1) 只填不提交
    await evaluate(optPage, `new Promise(r => chrome.storage.local.set({ settings: ${JSON.stringify(
      Object.assign({}, base, { autoLogin: true, loginAutoSubmit: false, loginStudentId: TEST_ID, loginName: TEST_NAME })
    )} }, r))`);
    const p1 = await openLoginPage('?case=fill-only');
    const s1 = await evaluate(p1, `({
      sid: document.getElementById('sid').value,
      name: document.getElementById('sname').value,
      submitted: window.__login.submitted,
      btnDisabled: document.getElementById('loginBtn').disabled
    })`);
    check('自动填入学号', s1.sid === TEST_ID, JSON.stringify(s1.sid));
    check('自动填入姓名', s1.name === TEST_NAME, JSON.stringify(s1.name));
    check('默认不自动提交', s1.submitted === false);
    check('按钮变为可点击', s1.btnDisabled === false);

    // 2) 自动提交
    await evaluate(optPage, `new Promise(r => chrome.storage.local.set({ settings: ${JSON.stringify(
      Object.assign({}, base, { autoLogin: true, loginAutoSubmit: true, loginStudentId: TEST_ID, loginName: TEST_NAME })
    )} }, r))`);
    const p2 = await openLoginPage('?case=auto-submit');
    await new Promise((r) => setTimeout(r, 1500));
    const s2 = await evaluate(p2, `({
      submitted: window.__login.submitted,
      payload: window.__login.payload,
      text: document.body.innerText.slice(0, 40)
    })`);
    check('自动提交登录', s2.submitted === true, JSON.stringify(s2));
    check('提交的凭据正确', s2.payload && s2.payload.sid === TEST_ID && s2.payload.name === TEST_NAME);

    // 3) 没开自动登录时绝不动表单
    await evaluate(optPage, `new Promise(r => chrome.storage.local.set({ settings: ${JSON.stringify(
      Object.assign({}, base, { autoLogin: false, loginAutoSubmit: true, loginStudentId: TEST_ID, loginName: TEST_NAME })
    )} }, r))`);
    const p3 = await openLoginPage('?case=disabled');
    await new Promise((r) => setTimeout(r, 1200));
    const s3 = await evaluate(p3, `({
      sid: document.getElementById('sid').value,
      submitted: window.__login.submitted
    })`);
    check('开关关闭时不填写', s3.sid === '' && s3.submitted === false, JSON.stringify(s3));

    // 4) 非登录页（聊天页）不应被误判
    await evaluate(optPage, `new Promise(r => chrome.storage.local.set({ settings: ${JSON.stringify(
      Object.assign({}, base, { autoLogin: true, loginAutoSubmit: true, loginStudentId: TEST_ID, loginName: TEST_NAME })
    )} }, r))`);
    const { targetId: chatId } = await browser.send('Target.createTarget', {
      url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-coze.html'
    });
    let ct;
    for (let i = 0; i < 40; i++) {
      const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      ct = ts.find((x) => x.id === chatId);
      if (ct && /mock-coze/.test(ct.url)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const chatPage = await openWs(ct.webSocketDebuggerUrl);
    await chatPage.send('Runtime.enable');
    await new Promise((r) => setTimeout(r, 2500));
    const s4 = await evaluate(chatPage, `({
      editor: document.getElementById('editor').innerText.trim(),
      loginFilled: document.querySelectorAll('input').length
    })`);
    check('聊天页不会被误填登录信息', s4.editor === '', JSON.stringify(s4));

    // 5) Coze 真实结构：标签在输入框上方、输入框无 placeholder
    const { targetId: cozeId } = await browser.send('Target.createTarget', {
      url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-login-coze.html'
    });
    let zt;
    for (let i = 0; i < 40; i++) {
      const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      zt = ts.find((x) => x.id === cozeId);
      if (zt && /mock-login-coze/.test(zt.url)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const cozePage = await openWs(zt.webSocketDebuggerUrl);
    await cozePage.send('Runtime.enable');
    // 等页面和扩展都就绪
    for (let i = 0; i < 30; i++) {
      const ready = await evaluate(cozePage, `document.querySelectorAll('.field input').length >= 2`);
      if (ready) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 2600));
    // 登录成功后页面会被替换成「登录成功」，所以要看 __login 记录和页面文字，
    // 而不是去找已经消失的输入框。
    const s5 = await evaluate(cozePage, `({
      submitted: window.__login.submitted,
      payload: window.__login.payload,
      text: document.body.innerText.slice(0, 80)
    })`);
    console.log('  coze-page:', JSON.stringify(s5));
    check('Coze 结构：自动填入学号', s5.payload && s5.payload.sid === TEST_ID, JSON.stringify(s5.payload));
    check('Coze 结构：自动填入姓名', s5.payload && s5.payload.name === TEST_NAME, JSON.stringify(s5.payload));
    check('Coze 结构：登录成功', /登录成功/.test(s5.text), JSON.stringify(s5.text));
  } catch (e) {
    check('测试执行', false, e.message);
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
    server.close();
    chrome.kill();
    await cleanup(TMP);
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
