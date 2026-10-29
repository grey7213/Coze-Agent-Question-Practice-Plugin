/* 用真实配置跑一次完整链路：
   - 把 tools/env.local.json 的内容写进扩展存储（密钥只在进程内存里读，不打印）
   - 通过扩展的后台 service worker 真实调用模型
   - 验证生成的答案能解析、能填进输入框、默认不自动发送

   用法: node tests/run-live.js
*/
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP_ROOT = path.join(require('os').tmpdir(), 'cah-live');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

const WEB_PORT = 8127;
const CDP_PORT = 9337;
const TMP = TMP_ROOT;
const EXT = path.join(TMP, 'ext');
const PROFILE = path.join(TMP, 'profile');
const CFG_PATH = path.join(ROOT, 'tools', 'env.local.json');

if (!fs.existsSync(CFG_PATH)) {
  console.error('缺少 tools/env.local.json，先运行生成命令。');
  process.exit(1);
}
const CFG = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
if (!CFG.apiKey) {
  console.error('env.local.json 里没有 apiKey。');
  process.exit(1);
}

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

function servers() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, p === '/' ? '/tests/mock-coze.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
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

function client(ws) {
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

async function openWs(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  return client(ws);
}

async function evaluate(cli, expr) {
  const r = await cli.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  return r.result.value;
}

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  };

  buildExt();
  const server = await servers();
  // 真实接口需要授权，测试版直接把 origin 加进 host_permissions
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  if (CFG.baseUrl && /^https?:/.test(CFG.baseUrl)) {
    mf.host_permissions.push(new URL(CFG.baseUrl).origin + '/*');
    fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));
  }

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
    const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
    const extId = loaded.id;
    console.log('扩展 id =', extId);

    // 写配置
    const { targetId: optTarget } = await browser.send('Target.createTarget', {
      url: 'chrome-extension://' + extId + '/src/options/options.html'
    });
    let opt;
    for (let i = 0; i < 40; i++) {
      const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      opt = ts.find((x) => x.id === optTarget);
      if (opt) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const optPage = await openWs(opt.webSocketDebuggerUrl);
    await optPage.send('Runtime.enable');
    await new Promise((r) => setTimeout(r, 500));

    const settings = {
      provider: CFG.provider,
      baseUrl: CFG.baseUrl,
      apiKey: CFG.apiKey,
      model: CFG.model,
      temperature: 0.2,
      maxTokens: 512,
      systemPrompt: '',
      autoGenerate: true,
      autoFill: true,
      requireConfirm: true,
      autoAdvance: false,
      advanceText: '是',
      stabilizeMs: 1200,
      actionDelayMs: 350,
      maxRounds: 5,
      overrides: { messageList: '', input: '', sendButton: '' }
    };
    await evaluate(optPage, `new Promise(r => chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }, r))`);
    check('配置写入扩展存储', await evaluate(optPage, `new Promise(r => chrome.storage.local.get('settings', d => r(!!d.settings.apiKey)))`));

    // 后台直连模型
    const t0 = Date.now();
    const ask = await evaluate(optPage, `new Promise(r => {
      chrome.runtime.sendMessage({
        type: 'ask',
        question: '第 1 题（单选）Java 中用于声明常量的关键字是？\\nA. final\\nB. static\\nC. const\\nD. public',
        history: [],
        systemPrompt: ''
      }, res => r(res || { ok: false, error: 'no response' }));
    })`);
    check('后台调用真实模型', ask && ask.ok === true, ask && ask.ok ? '' : (ask && ask.error));
    if (ask && ask.ok) {
      console.log('  答案:', JSON.stringify(ask.answer), ' 耗时:', Date.now() - t0, 'ms');
      console.log('  解析:', JSON.stringify((ask.explanation || '').slice(0, 60)));
      check('答案非空', !!ask.answer);
    }

    // 完整 UI 链路
    const { targetId } = await browser.send('Target.createTarget', { url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-coze.html' });
    let pt;
    for (let i = 0; i < 40; i++) {
      const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      pt = ts.find((x) => x.id === targetId);
      if (pt && /mock-coze/.test(pt.url)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const page = await openWs(pt.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await new Promise((r) => setTimeout(r, 2500));

    await evaluate(page, `(() => {
      const h = document.getElementById('cah-panel-host');
      [...h.shadowRoot.querySelectorAll('button')].find(b => b.textContent.trim() === '开始').click();
      return true;
    })()`);

    // 等真实模型返回并填进输入框
    let filled = '';
    for (let i = 0; i < 60; i++) {
      filled = await evaluate(page, `document.getElementById('editor').innerText.trim()`);
      if (filled) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const sent = await evaluate(page, `window.__mock.log.filter(x => x.startsWith('me:'))`);
    check('真实模型答案填入输入框', !!filled, JSON.stringify(filled));
    check('默认配置下未自动发送', sent.length === 0, JSON.stringify(sent));

    // 点发送，验证发送成功
    if (filled) {
      await evaluate(page, `(() => {
        const h = document.getElementById('cah-panel-host');
        [...h.shadowRoot.querySelectorAll('button')].find(b => b.textContent.trim() === '发送').click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 2500));
      const sent2 = await evaluate(page, `window.__mock.log.filter(x => x.startsWith('me:'))`);
      check('手动点发送后消息发出', sent2.length === 1 && sent2[0] === 'me: ' + filled, JSON.stringify(sent2));
    }
  } catch (e) {
    check('测试执行', false, e.message);
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
    server.close();
    chrome.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
