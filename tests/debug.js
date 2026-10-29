const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const WEB = 8124;
const CDP = 9334;

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(ROOT, p === '/' ? '/tests/mock-coze.html' : p);
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8' });
  fs.createReadStream(f).pipe(res);
});

const getJson = (u) => new Promise((r, j) => http.get(u, (x) => {
  let d = '';
  x.on('data', (c) => (d += c));
  x.on('end', () => { try { r(JSON.parse(d)); } catch (e) { j(e); } });
}).on('error', j));

(async () => {
  await new Promise((r) => server.listen(WEB, '127.0.0.1', r));
  const dir = path.join(ROOT, 'tests', '.tmp-dbg');
  fs.rmSync(dir, { recursive: true, force: true });
  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + CDP, '--user-data-dir=' + dir, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try { await getJson('http://127.0.0.1:' + CDP + '/json/version'); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }
  const v = await getJson('http://127.0.0.1:' + CDP + '/json/version');
  const ws = new WebSocket(v.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); }
  });
  const send = (method, params) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const list = await getJson('http://127.0.0.1:' + CDP + '/json/list');
  const t = list.find((x) => x.id === targetId);
  const pws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => pws.addEventListener('open', r, { once: true }));
  const ppend = new Map();
  let pid = 0;
  pws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && ppend.has(m.id)) { ppend.get(m.id)(m); ppend.delete(m.id); }
  });
  const psend = (method, params) => new Promise((r) => { const i = ++pid; ppend.set(i, r); pws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  await psend('Runtime.enable');
  await psend('Page.enable');
  for (const f of ['src/shared/defaults.js', 'src/core/util.js', 'src/core/detect.js', 'src/core/fill.js', 'src/core/engine.js']) {
    await psend('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.join(ROOT, f), 'utf8') });
  }
  await psend('Page.navigate', { url: 'http://127.0.0.1:' + WEB + '/tests/mock-coze.html' });
  await new Promise((r) => setTimeout(r, 1500));
  const ev = async (expr) => {
    const r = await psend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result.exceptionDetails) return 'EXC: ' + JSON.stringify(r.result.exceptionDetails.exception && r.result.exceptionDetails.exception.description);
    return r.result.result.value;
  };
  console.log('rows:', JSON.stringify(await ev(`__CAH__.detect.getMessageRows(__CAH__.detect.findMessageList()).map(r=>__CAH__.util.textOf(r).slice(0,50))`), null, 1));
  console.log('list:', await ev(`(e=>e.tagName+'.'+e.className)(__CAH__.detect.findMessageList())`));
  console.log('container:', await ev(`(e=>e&&e.tagName+'.'+e.className)(__CAH__.detect.findScrollContainer())`));
  console.log('classify Q:', await ev(`__CAH__.classify.looksLikeQuestion('第 1 题（单选）Java 中用于声明常量的关键字是？')`));
  console.log('classify C:', await ev(`__CAH__.classify.isContinuePrompt('回答已记录。是否继续下一题？回复「是」。', __CAH__.classify.buildPatterns({}))`));
  ch.kill();
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
