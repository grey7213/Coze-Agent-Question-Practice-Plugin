/* 端到端测试：把扩展真正装进 Chrome，跑一个本地 mock 模型接口。
   与 run-test.js 的区别：这里验证 manifest、权限、content script 注入、
   隔离世界与页面通信、后台 service worker 调模型、面板交互，全都走真实链路。

   用法: node tests/run-e2e.js
*/
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

const WEB_PORT = 8125;
const CDP_PORT = 9335;
const TMP = path.join(require('os').tmpdir(), 'cah-e2e');
const EXT = path.join(TMP, 'ext');
const PROFILE = path.join(TMP, 'profile');

const MODEL_ANSWER = 'A';
let modelCalls = [];

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (['tests', 'tools', 'specs', 'output', '.git'].includes(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    e.isDirectory() ? copyDir(s, d) : fs.copyFileSync(s, d);
  }
}

function buildTestExtension() {
  fs.rmSync(TMP, { recursive: true, force: true });
  copyDir(ROOT, EXT);
  const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
  // 测试版：直接给权限（省掉用户手势授权），并把内容脚本挂到本地测试页
  mf.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
  mf.content_scripts[0].matches.push('http://127.0.0.1/*');
  // Exercise any existing resource exposure on the local test origin as well.
  for (const resource of mf.web_accessible_resources || []) resource.matches.push('http://127.0.0.1/*');
  fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));
  fs.mkdirSync(path.join(EXT, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(EXT, 'tools/env.local.json'), JSON.stringify({
    apiKey: 'fixture-local-key', loginStudentId: '20240001', loginName: '测试姓名',
    autoLogin: false, loginAutoSubmit: false
  }));
}

function startServers() {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body); } catch (e) { /* ignore */ }
        modelCalls.push(parsed);
        const msg = (parsed.messages || []).map((m) => m.content).join('\n');
        // 简单判题：以最后出现的「第 N 题」为准（历史里还有更早的题）
        const all = [...msg.matchAll(/第\s*(\d+)\s*题/g)];
        const n = all.length ? Number(all[all.length - 1][1]) : 1;
        const ans = n === 2 ? '正确' : n === 3 ? 'ABC' : 'A';
        const content = '答案: ' + ans + '\n解析: mock';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }));
      });
      return;
    }
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

class Client {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
}

async function openWs(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  return new Client(ws);
}

async function connectPage(target) {
  const c = await openWs(target.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  await c.send('Page.enable');
  return c;
}

async function evaluate(cli, expr) {
  const r = await cli.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
  }
  return r.result.value;
}

async function main() {
  buildTestExtension();
  const server = await startServers();

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      '--enable-unsafe-extension-debugging',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      'about:blank'
    ],
    { stdio: 'ignore' }
  );

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  };

  try {
    await waitJson('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);

    // 扩展 id 随机（loadUnpacked 不再按路径派生），必须通过 CDP 拿
    const ver = await waitJson('http://127.0.0.1:' + CDP_PORT + '/json/version', 20000);
    const browser = await openWs(ver.webSocketDebuggerUrl);
    const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT });
    const extId = loaded.id;
    console.log('扩展 id =', extId);
    check('扩展加载成功', !!extId);

    // 等 service worker 起来
    let swUrl = '';
    for (let i = 0; i < 40 && !swUrl; i++) {
      const targets = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      const sw = targets.find((x) => x.type === 'service_worker' && x.url.includes(extId));
      if (sw) swUrl = sw.url;
      else await new Promise((r) => setTimeout(r, 250));
    }
    check('service worker 启动', /background\.js/.test(swUrl), swUrl || '未启动');

    // 1) 设置页可打开
    const { targetId: optTarget } = await browser.send('Target.createTarget', {
      url: 'chrome-extension://' + extId + '/src/options/options.html'
    });
    let opt;
    for (let i = 0; i < 40; i++) {
      const targets = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      const t = targets.find((x) => x.id === optTarget);
      if (t) { opt = t; break; }
      await new Promise((r) => setTimeout(r, 150));
    }
    const optPage = await connectPage(opt);
    await new Promise((r) => setTimeout(r, 600));
    check('设置页加载', await evaluate(optPage, 'document.querySelectorAll("input,select,textarea").length > 10'));
    check('预设可选项 ≥ 6', (await evaluate(optPage, 'document.getElementById("preset").options.length')) >= 7);

    const init = await evaluate(optPage, `chrome.runtime.sendMessage({ type: 'init-settings' })`);
    const imported = await evaluate(optPage, `chrome.storage.local.get('settings').then(d => ({
      keyImported: d.settings.apiKey === 'fixture-local-key',
      idImported: d.settings.loginStudentId === '20240001'
    }))`);
    check('后台从私有本地配置导入', imported.keyImported && imported.idImported);
    check('发给内容脚本的设置不含密钥', init.ok && !Object.hasOwn(init.settings, 'apiKey'));

    // 2) 写入测试用设置
    const settings = {
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:' + WEB_PORT + '/v1',
      apiKey: 'test-key',
      model: 'mock-model',
      temperature: 0,
      maxTokens: 128,
      autoGenerate: true,
      autoFill: true,
      requireConfirm: false,
      autoAdvance: true,
      advanceText: '是',
      stabilizeMs: 300,
      actionDelayMs: 50,
      maxRounds: 6,
      overrides: { messageList: '', input: '', sendButton: '' }
    };
    await evaluate(optPage, `new Promise(r => chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }, r))`);
    const stored = await evaluate(optPage, 'new Promise(r => chrome.storage.local.get("settings", d => r(d.settings)))');
    check('设置写入 storage', stored && stored.apiKey === 'test-key' && stored.stabilizeMs === 300);
    const update = await evaluate(optPage, `chrome.runtime.sendMessage({ type: 'update-content-settings', settings: {
      requireConfirm: true, apiKey: 'must-not-overwrite', model: 'must-not-overwrite'
    }}).then(() => chrome.storage.local.get('settings')).then(d => ({
      keptKey: d.settings.apiKey === 'test-key', keptModel: d.settings.model === 'mock-model', changed: d.settings.requireConfirm
    }))`);
    check('面板更新保留密钥和模型配置', update.keptKey && update.keptModel && update.changed);
    await evaluate(optPage, `chrome.runtime.sendMessage({ type: 'update-content-settings', settings: { requireConfirm: false } })`);

    // 3) 打开 mock 页面，内容脚本应注入
    const { targetId } = await browser.send('Target.createTarget', { url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-coze.html' });
    let pageTarget;
    for (let i = 0; i < 40; i++) {
      const targets = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      pageTarget = targets.find((x) => x.id === targetId);
      if (pageTarget && /mock-coze/.test(pageTarget.url)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const page = await connectPage(pageTarget);
    await new Promise((r) => setTimeout(r, 2500));

    check('内容脚本注入面板', await evaluate(page, '!!document.getElementById("cah-panel-host")'));
    check(
      '面板 Shadow DOM 可见',
      await evaluate(page, `(() => {
        const h = document.getElementById('cah-panel-host');
        if (!h || !h.shadowRoot) return false;
        return h.shadowRoot.querySelectorAll('button').length >= 6;
      })()`)
    );

    // 4) 点「开始」，走真实链路
    await evaluate(page, `(() => {
      const h = document.getElementById('cah-panel-host');
      const btns = [...h.shadowRoot.querySelectorAll('button')];
      const start = btns.find(b => b.textContent.trim() === '开始');
      start.click();
      return true;
    })()`);

    await new Promise((r) => setTimeout(r, 12000));

    const log = await evaluate(page, 'window.__mock.log.slice()');
    const finished = await evaluate(page, 'window.__mock.finished');
    console.log('  mock log:', log.join(' | '));
    console.log('  模型调用次数:', modelCalls.length);

    check('后台调用到 mock 模型', modelCalls.length >= 2, 'calls=' + modelCalls.length);
    check('答案确实发送到了对话里', log.some((x) => x === 'me: A'), log.find((x) => x.startsWith('me:')) || '');
    check('按题目返回不同答案', log.includes('me: 正确') && log.includes('me: ABC'), JSON.stringify(log.filter(x => x.startsWith('me:'))));
    check('自动回「是」生效', log.includes('me: 是'));
    check('三轮题目全部完成', finished === true);
    check('每题答案及继续提示仅发送一次，结束后不重发',
      JSON.stringify(log.filter(x => x.startsWith('me:'))) === JSON.stringify(['me: A','me: 是','me: 正确','me: 是','me: ABC','me: 是']));

    const state = await evaluate(page, `(() => {
      const h = document.getElementById('cah-panel-host');
      return h.shadowRoot.querySelector('header .title').textContent;
    })()`);
    check('面板状态有更新', /Coze 答题助手/.test(state), state);

    // 5) API key 不出现在页面上下文
    const leaked = await evaluate(page, `(() => {
      try {
        return document.documentElement.innerHTML.includes('test-key');
      } catch (e) { return false; }
    })()`);
    check('API Key 未泄露到页面 DOM', leaked === false);
    const resourceReadable = await evaluate(page, `fetch('chrome-extension://${extId}/tools/env.local.json')
      .then(r => r.ok ? r.text() : '').then(text => text.includes('fixture-local-key')).catch(() => false)`);
    check('网页无法读取扩展私有配置', resourceReadable === false);

    // 6) 默认配置（发送前确认、不自动回「是」）必须只填不发
    await evaluate(optPage, `new Promise(r => chrome.storage.local.set({ settings: Object.assign({}, ${JSON.stringify(
      Object.assign({}, settings, { requireConfirm: true, autoAdvance: false })
    )}) }, r))`);
    const { targetId: t2 } = await browser.send('Target.createTarget', { url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-coze.html?case=confirm' });
    let p2t;
    for (let i = 0; i < 40; i++) {
      const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      p2t = ts.find((x) => x.id === t2);
      if (p2t && /mock-coze/.test(p2t.url)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    const page2 = await connectPage(p2t);
    await new Promise((r) => setTimeout(r, 2200));
    await evaluate(page2, `(() => {
      const h = document.getElementById('cah-panel-host');
      [...h.shadowRoot.querySelectorAll('button')].find(b => b.textContent.trim() === '开始').click();
      return true;
    })()`);
    await new Promise((r) => setTimeout(r, 4500));
    const safe = await evaluate(page2, `(() => {
      const h = document.getElementById('cah-panel-host');
      const editor = document.getElementById('editor');
      return {
        sent: window.__mock.log.filter(x => x.startsWith('me:')),
        editorText: editor.innerText.trim(),
        panelAnswer: h.shadowRoot.querySelector('.a').textContent.trim(),
        title: h.shadowRoot.querySelector('header .title').textContent
      };
    })()`);
    check('默认配置下没有自动发送', safe.sent.length === 0, JSON.stringify(safe.sent));
    check('答案已填入输入框', safe.editorText === 'A', 'editor=' + safe.editorText);
    check('面板显示待发送', /待发送/.test(safe.title), safe.title);

    // 截图留证
    const shot = await page2.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.join(ROOT, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'specs', 'screenshot-default-confirm.png'), Buffer.from(shot.data, 'base64'));

  } catch (e) {
    check('测试执行', false, e.message);
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
    server.close();
    chrome.kill();
    await new Promise((r) => setTimeout(r, 500));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 文件占用时忽略 */ }
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
