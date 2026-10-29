/* 真实结构复刻：还原用户诊断里的两条关键线索
   1) #Page5 的子元素是 [聊天区, 查看排行, 返回上一页] —— 不能被当成消息列表
   2) 一条消息的文本是 JSON 字符串，另一条是普通中文
   用法: node tests/run-structure.js
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
  (process.env.LOCALAPPDATA || '').replace(/\\/g, '/') + '/Google/Chrome/Application/chrome.exe'
].find((p) => fs.existsSync(p));

const WEB_PORT = 8155;
const CDP_PORT = 9365;
const TMP = path.join(os.tmpdir(), 'cah-struct');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>structure</title>
<style>
  html,body{height:100%;margin:0;font:14px/1.6 sans-serif;background:#eef1f4}
  .coz-layout{height:100%;position:relative;display:flex;flex-direction:column}
  #Page5{flex:1;display:flex;flex-direction:column;min-height:0}
  .scrollable--pkXa6lFnTQUbfv8X{flex:1;overflow-y:auto;padding:20px}
  .msg-list{display:flex;flex-direction:column;gap:12px}
  .msg{max-width:78%;padding:12px;border-radius:10px;background:#fff;border:1px solid #e5e8eb;white-space:pre-wrap}
  .msg.me{align-self:flex-end;background:#ddf4e4}
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
        <div class="msg-list">
          <div class="msg">{"output":"恭喜你！完成了本轮作答。若想继续作答，可回复 “是”。"}</div>
          <div class="msg">《AI编程工具与高效开发》课程答题智能体</div>
          <div class="msg">测试同学，刚才的《AI 编程工具与高效开发》测试题：

考查知识点：【Java 基础 - 变量、标识符、基本数据类型、运算符】
【单选题】(2 分):
下列运算符中，属于算术运算符的是哪一项？
A: &&; B: =; C: +; D: ==</div>
        </div>
      </div>
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
    if (q.url === '/sdk') {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      r.end(fs.readFileSync(path.join(ROOT, 'tests/mock-coze-sdk.html')));
      return;
    }
    if (q.url === '/page') {
      r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      r.end(PAGE);
      return;
    }
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

  check('core 已注入', (await ev('typeof __CAH__')) !== 'undefined');

  const diag = await ev('__CAH__.detect.diagnose()');
  if (diag && !diag.__err) {
    const listStep = diag.steps.find((s) => s.step === '消息列表');
    const rowsStep = diag.steps.find((s) => s.step === '消息行');
    const inputStep = diag.steps.find((s) => s.step === '输入框');
    const sendStep = diag.steps.find((s) => s.step === '发送按钮');
    const clsStep = diag.steps.find((s) => s.step === '分类');

    console.log('  消息列表:', listStep.result, '| rows=', listStep.rows);
    console.log('  消息行:', JSON.stringify(rowsStep.last5));
    console.log('  输入框:', inputStep.result);
    console.log('  发送按钮:', sendStep.result);
    console.log('  分类:', JSON.stringify({ q: clsStep.isQuestion, c: clsStep.isContinue }));

    check('不把 #Page5 当消息列表', !/Page5/.test(listStep.result), listStep.result);
    check('消息列表选到真正的消息容器', /msg-list/.test(listStep.result), listStep.result);
    check('消息行取到 3 条', listStep.rows === 3, 'rows=' + listStep.rows);
    check('消息行里没有按钮文字', !(rowsStep.last5 || []).some((t) => /查看排行|返回上一页/.test(t)), JSON.stringify(rowsStep.last5));
    check('找到输入框', !!inputStep.result && !/未找到/.test(inputStep.result), inputStep.result);
    check('找到纯图标发送按钮', !!sendStep.result && !/未找到/.test(sendStep.result), sendStep.result);
    check('末条识别为题目', clsStep.isQuestion === true, '末条: ' + String(clsStep.lastText).slice(0, 40));
  } else {
    check('诊断可执行', false, JSON.stringify(diag));
  }

  // 关键：这套结构下引擎应能识别题目
  const engineTest = await ev(`(async () => {
    const settings = __CAH__.defaults.withDefaults({ autoGenerate: false, autoFill: true, requireConfirm: true, stabilizeMs: 200, apiKey: 'x' });
    let got = null;
    const engine = new __CAH__.Engine({ settings, askAI: async () => ({ ok: true, answer: 'C' }), emit: (e, d) => { if (e === 'question') got = d.text; } });
    engine.start();
    await new Promise(r => setTimeout(r, 4000));
    engine.stop();
    return { question: got ? got.slice(0, 60) : null, state: engine.state };
  })()`);
  check('引擎在真实结构上识别到题目', !!engineTest.question, JSON.stringify(engineTest));

  await page.send('Page.navigate', { url: `http://127.0.0.1:${WEB_PORT}/sdk` });
  await sleep(1000);
  const sdk = await ev(`(() => {
    const D=__CAH__.detect, U=__CAH__.util;
    const list=D.findMessageList(), rows=D.getMessageRows(list);
    return { list:list.id, ids:rows.map(e=>e.dataset.messageId),
      last:rows.length?U.textOf(rows[rows.length-1]):'',
      feedback:__CAH__.classify.isFeedback(document.querySelector('[data-message-id="fixture-007"]').innerText),
      input:D.findInput()?.id, send:!!D.findSendButton(D.findInput()) };
  })()`);
  check('真实 SDK：深层卡片定位到聊天滚动区', sdk.list === 'sdk-scroll', sdk.list);
  check('真实 SDK：分离全部八条消息', sdk.ids?.length === 8, JSON.stringify(sdk.ids));
  check('真实 SDK：两层倒序后当前题目位于末尾', sdk.ids?.at(-1) === 'fixture-008' && /int a = 15/.test(sdk.last));
  check('真实 SDK：引用旧题的判分仍是反馈', sdk.feedback === true);
  check('真实 SDK：输入框和图标发送按钮可用', sdk.input === 'sdk-editor' && sdk.send);

  const sdkFlow = await ev(`(async () => {
    let calls=0;
    const settings=__CAH__.defaults.withDefaults({requireConfirm:true,autoAdvance:false,stabilizeMs:200});
    const engine=new __CAH__.Engine({settings,askAI:async()=>{calls++;return{ok:true,answer:'A'};}});
    engine.start();await new Promise(r=>setTimeout(r,1800));
    const initial={calls,question:engine.question,filled:document.querySelector('#sdk-editor').value,sent:__sdk.sent.length};
    if(engine.answer){await engine.sendCurrent();await engine.sendCurrent();}
    await new Promise(r=>setTimeout(r,1800));
    const waiting={calls,sent:__sdk.sent.length};
    __sdk.append('【单选题】(2 分)：已知 int a = 15，输出结果是？\\nA. 大；B. 小\\n你的回答是：A\\n正确答案：A\\n本题得分：2');
    await new Promise(r=>setTimeout(r,1500));
    const feedbackCalls=calls;
    __sdk.append('全部题目已完成，感谢作答。');
    await new Promise(r=>setTimeout(r,1500));
    const finished={calls,sent:__sdk.sent.length};engine.stop();
    return{initial,waiting,feedbackCalls,finished};
  })()`);
  check('真实 SDK：只生成当前题目并填入答案', sdkFlow.initial?.calls === 1 && sdkFlow.initial.filled === 'A' && /int a = 15/.test(sdkFlow.initial.question));
  check('真实 SDK：默认确认模式没有发送', sdkFlow.initial?.sent === 0);
  check('真实 SDK：连点发送及慢回复不会重复提交', sdkFlow.waiting?.sent === 1 && sdkFlow.waiting.calls === 1, JSON.stringify(sdkFlow.waiting));
  check('真实 SDK：收到判分不再回答旧题', sdkFlow.feedbackCalls === 1);
  check('真实 SDK：结束后不回扫历史继续提示', sdkFlow.finished?.calls === 1 && sdkFlow.finished.sent === 1, JSON.stringify(sdkFlow.finished));

  console.log('\n' + results.filter((r) => r.ok).length + '/' + results.length + ' 通过');
  srv.close();
  ch.kill();
  setTimeout(() => process.exit(results.every((r) => r.ok) ? 0 : 1), 300);
})().catch((e) => { console.error(e); process.exit(1); });
