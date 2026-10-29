/* 复刻用户截图里的真实场景：
   - 聊天卡片底部有页脚「内容由AI生成，无法确保真实准确，仅供参考」
   - 页脚下方还有「查看排行 / 返回上一页」按钮
   - 真正的题目在页脚上方
   验证：不会因为页脚在最后而识别失败。

   用法: node tests/run-noisy.js
*/
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find((p) => fs.existsSync(p));

const WEB_PORT = 8157;
const CDP_PORT = 9367;
const TMP = path.join(os.tmpdir(), 'cah-noisy');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>noisy</title>
<style>
  html,body{height:100%;margin:0;font:14px/1.6 sans-serif;background:#eef1f4}
  .coz-layout{height:100%;display:flex;flex-direction:column;position:relative}
  #Page5{flex:1;display:flex;flex-direction:column;min-height:0}
  .scrollable--pkXa6lFnTQUbfv8X{flex:1;overflow-y:auto;padding:20px}
  .msg-list{display:flex;flex-direction:column;gap:12px}
  .msg-card{background:#fff;border:1px solid #e5e8eb;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px}
  .msg{max-width:78%;padding:12px;border-radius:10px;background:#fff;border:1px solid #e5e8eb;white-space:pre-wrap}
  .msg.me{align-self:flex-end;background:#ddf4e4}
  .footer-note{color:#8c959f;font-size:12px;text-align:center;margin-top:8px}
  .toolbar{display:flex;gap:10px;padding:10px 20px;background:#fff;border-top:1px solid #e5e8eb}
  .toolbar button{padding:8px 16px;border:1px solid #d0d7de;border-radius:8px;background:#fff;font:inherit;cursor:pointer}
  .composer{display:flex;gap:10px;padding:12px 16px;background:#fff;border-top:1px solid #e5e8eb}
  textarea{flex:1;min-height:44px;padding:10px;border:1px solid #d0d7de;border-radius:8px;font:inherit;resize:none}
  .sb{width:40px;height:40px;border:0;border-radius:8px;background:#1f883d;color:#fff;cursor:pointer}
  .sb[disabled]{background:#c9d1d9}
</style></head>
<body>
<div class="coz-layout flex-1 relative">
  <div id="Page5" class="ui-builder-page">
    <div class="chat-area">
      <div class="scrollable--pkXa6lFnTQUbfv8X">
        <!-- 真实结构：整块对话是一张卡片，不是多条独立元素 -->
        <div class="msg-card">
          <div class="msg">《AI编程工具与高效开发》课程答题智能体</div>
          <div class="msg">考查知识点：【Java 基础 - if 判断、switch】
【判断题】(2 分)：
Java 中 if 语句的条件表达式结果必须是 boolean 类型。
A: 正确; B: 错误</div>
        </div>
      </div>
      <div class="footer-note">内容由AI生成，无法确保真实准确，仅供参考。</div>
    </div>
    <div class="toolbar">
      <button type="button">查看排行</button>
      <button type="button">返回上一页</button>
    </div>
    <div class="composer">
      <textarea placeholder="发送消息"></textarea>
      <button class="sb" type="button" disabled><svg width="16" height="16" viewBox="0 0 16 16"><path d="M8 2l6 6H9v6H7V8H2l6-6z" fill="currentColor"/></svg></button>
    </div>
  </div>
</div>
</body></html>`;

const getJson = (u) =>
  new Promise((res, rej) =>
    http.get(u, (x) => { let d = ''; x.on('data', (c) => (d += c)); x.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } }); }).on('error', rej)
  );

async function ws(url) {
  const w = new WebSocket(url);
  await new Promise((r) => w.addEventListener('open', r, { once: true }));
  const c = { id: 0, pending: new Map(), contexts: [] };
  w.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && c.pending.has(m.id)) { c.pending.get(m.id)(m); c.pending.delete(m.id); }
    if (m.method === 'Runtime.executionContextCreated') c.contexts.push(m.params.context);
  });
  c.send = (method, params) => new Promise((r) => { const i = ++c.id; c.pending.set(i, r); w.send(JSON.stringify({ id: i, method, params })); });
  return c;
}

(async () => {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ ok });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  };

  const srv = http.createServer((q, r) => {
    if (q.url === '/page') { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(PAGE); return; }
    const p = decodeURIComponent(q.url.split('?')[0]);
    const f = path.join(ROOT, p);
    if (!fs.existsSync(f)) { r.writeHead(404); r.end('nf'); return; }
    r.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    fs.createReadStream(f).pipe(r);
  });
  await new Promise((r) => srv.listen(WEB_PORT, '127.0.0.1', r));

  const ch = spawn(CHROME, ['--headless=new', '--disable-gpu', '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + TMP, 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); break; } catch (e) { await sleep(250); } }

  const ver = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const browser = await ws(ver.webSocketDebuggerUrl);
  const { targetId } = (await browser.send('Target.createTarget', { url: `http://127.0.0.1:${WEB_PORT}/page` })).result;
  await sleep(1200);

  const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
  const t = list.find((x) => x.id === targetId);
  const page = await ws(t.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  for (const f of ['src/shared/build.js', 'src/shared/defaults.js', 'src/core/util.js', 'src/core/detect.js', 'src/core/fill.js', 'src/core/login.js', 'src/core/engine.js']) {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.join(ROOT, f), 'utf8') });
  }
  await page.send('Page.reload');
  await sleep(2200);

  const ev = async (expr) => {
    const r = await page.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) return { __err: r.result.exceptionDetails.text };
    return r.result.result.value;
  };

  const diag = await ev('__CAH__.detect.diagnose()');
  if (diag && !diag.__err) {
    const listStep = diag.steps.find((s) => s.step === '消息列表');
    const rowsStep = diag.steps.find((s) => s.step === '消息行');
    console.log('  消息列表:', listStep.result, '| rows=', listStep.rows);
    console.log('  消息行:', JSON.stringify(rowsStep.last5, null, 1));
    check('消息列表不在 #Page5', !/Page5/.test(listStep.result), listStep.result);
    check('消息行里没有按钮文字', !(rowsStep.last5 || []).some(t => /查看排行|返回上一页/.test(t)));
  }

  // 关键：引擎必须跳过页脚，选中那道判断题
  const r = await ev(`(async () => {
    const settings = __CAH__.defaults.withDefaults({
      autoGenerate: false, autoFill: false, requireConfirm: true, stabilizeMs: 200, apiKey: 'x'
    });
    let got = null;
    const engine = new __CAH__.Engine({
      settings,
      askAI: async () => ({ ok: true, answer: 'A' }),
      emit: (e, d) => { if (e === 'question') got = d.text; }
    });
    engine.start();
    await new Promise(res => setTimeout(res, 4000));
    engine.stop();

    const msgs = engine.readMessages();
    const picked = engine.pickTargetMessage(msgs);
    return {
      question: got,
      picked: picked ? picked.text.slice(0, 80) : null,
      allRows: msgs.map(m => m.text.slice(0, 40))
    };
  })()`);

  console.log('  全部消息行:', JSON.stringify(r.allRows, null, 1));
  console.log('  选中:', JSON.stringify(r.picked));

  check('引擎识别到题目（不被页脚挡住）', !!r.question, r.question ? r.question.slice(0, 50).replace(/\n/g, ' ') : 'null');
  check('选中的是判断题而不是页脚', /判断题|boolean/.test(r.question || ''), String(r.question || '').slice(0, 40));
  check('pickTargetMessage 跳过页脚', !/内容由AI生成/.test(r.picked || ''), r.picked);

  console.log('\n' + results.filter((x) => x.ok).length + '/' + results.length + ' 通过');
  srv.close();
  ch.kill();
  setTimeout(() => process.exit(results.every((x) => x.ok) ? 0 : 1), 300);
})().catch((e) => { console.error(e); process.exit(1); });
