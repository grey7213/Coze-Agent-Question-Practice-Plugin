/* 真实 Coze 页面逐步验证。
   用法: node tests/real-flow.js <步骤>
     open    打开商店页，找到 iframe 并确认登录表单被自动填写
     login   点击登录，进入答题页
     probe   打印当前页面的识别结果（消息列表 / 输入框 / 题目分类）
*/
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.CAH_CDP_PORT || 9222);
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'output', 'playwright');
const connections = new Set();
const privateValues = (() => {
  try {
    const local = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/env.local.json'), 'utf8'));
    return [local.apiKey, local.loginStudentId, local.loginName].filter(Boolean);
  } catch (_) { return []; }
})();
function redact(value) {
  let text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text == null) return text;
  for (const secret of privateValues) text = text.split(secret).join('[已隐藏]');
  return text;
}
for (const method of ['log', 'error', 'warn']) {
  const original = console[method].bind(console);
  console[method] = (...args) => original(...args.map(redact));
}
const COZE_URL =
  'https://www.coze.cn/store/project/7689061576766685203?entity_id=1&bid=6locg16u84g1m&share=1&from=others';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getJson = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('CDP HTTP ' + response.status);
  return response.json();
};

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    const timer = setTimeout(() => { ws.close(); j(new Error('连接 Chrome 调试端口超时')); }, 5000);
    ws.addEventListener('open', () => { clearTimeout(timer); r(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); j(new Error('Chrome 调试连接失败')); }, { once: true });
  });
  connections.add(ws);
  const c = { ws, id: 0, pending: new Map(), contexts: [], destroyed: new Set() };
  ws.addEventListener('close', () => {
    connections.delete(ws);
    for (const job of c.pending.values()) { clearTimeout(job.timer); job.reject(new Error('Chrome 调试连接已关闭')); }
    c.pending.clear();
  });
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && c.pending.has(m.id)) {
      const { resolve, reject, timer } = c.pending.get(m.id);
      clearTimeout(timer);
      c.pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method === 'Runtime.executionContextCreated') {
      c.contexts.push(m.params.context);
      c.destroyed.delete(m.params.context.id);
    } else if (m.method === 'Runtime.executionContextDestroyed') {
      c.contexts = c.contexts.filter((x) => x.id !== m.params.executionContextId);
      c.destroyed.add(m.params.executionContextId);
    } else if (m.method === 'Runtime.executionContextsCleared') {
      c.contexts = [];
      c.destroyed.clear();
    }
  });
  c.send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++c.id;
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new Error(method + ' 超时（8s）'));
      }, 8000);
      c.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  return c;
}

/** 在给定上下文里求值；上下文已销毁时返回 null 而不是抛错 */
async function tryEval(page, expr, contextId) {
  if (contextId && page.destroyed.has(contextId)) return null;
  try {
    const p = { expression: expr, awaitPromise: true, returnByValue: true, timeout: 5000 };
    if (contextId) p.contextId = contextId;
    const r = await page.send('Runtime.evaluate', p);
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result.value;
  } catch (e) {
    return null;
  }
}

/** 按「是否顶层 + 是否含扩展脚本」给上下文分类 */
async function classifyContexts(page) {
  const out = { top: [], frames: [] };
  for (const c of page.contexts.slice()) {
    if (page.destroyed.has(c.id)) continue;
    if ((c.name || '').startsWith('__playwright')) continue;
    const info = await tryEval(
      page,
      `({ isTop: window.top === window, hasExt: typeof __CAH__ !== 'undefined',
          url: location.href, textareas: document.querySelectorAll('textarea').length,
          inputs: document.querySelectorAll('input').length,
          panel: !!document.getElementById('cah-panel-host'),
          build: typeof __CAH__ !== 'undefined' ? __CAH__.BUILD : null })`,
      c.id
    );
    if (!info || info.__err) continue;
    const rec = Object.assign({ ctxId: c.id, name: c.name || '' }, info);
    if (info.isTop) out.top.push(rec);
    else out.frames.push(rec);
  }
  return out;
}

async function shot(page, name) {
  if (process.argv.includes('--no-screenshot')) return null;
  try {
    await page.send('Page.bringToFront');
    const version = await getJson(`http://127.0.0.1:${PORT}/json/version`);
    const browser = await connect(version.webSocketDebuggerUrl);
    try {
      const window = await browser.send('Browser.getWindowForTarget', { targetId: page.targetId });
      if (window.bounds.windowState === 'minimized') {
        await browser.send('Browser.setWindowBounds', { windowId: window.windowId, bounds: { windowState: 'normal' } });
        await page.send('Page.bringToFront');
        await sleep(400);
      }
      const s = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: false });
      fs.mkdirSync(OUTPUT, { recursive: true });
      const p = path.join(OUTPUT, name);
      fs.writeFileSync(p, Buffer.from(s.data, 'base64'));
      console.log('截图:', p);
      return p;
    } finally { browser.ws.close(); }
  } catch (error) {
    console.warn('截图未完成（诊断继续）:', error.message);
    return null;
  }
}

async function getTarget(id) {
  const list = await getJson(`http://127.0.0.1:${PORT}/json/list`);
  return (id && list.find((t) => t.id === id && t.type === 'page')) ||
    list.find((t) => t.type === 'page' && /^https:\/\/www\.coze\.cn\//.test(t.url) && t.url.includes('7689061576766685203'));
}

async function openPage(url) {
  const ver = await getJson(`http://127.0.0.1:${PORT}/json/version`);
  const browser = await connect(ver.webSocketDebuggerUrl);
  const { targetId } = await browser.send('Target.createTarget', { url });
  let t;
  for (let i = 0; i < 60; i++) {
    t = await getTarget(targetId);
    if (t) break;
    await sleep(200);
  }
  const page = await connect(t.webSocketDebuggerUrl);
  page.targetId = t.id;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return { browser, page, targetId };
}

async function attach(targetId) {
  const t = await getTarget(targetId);
  if (!t) throw new Error('目标页面不存在');
  const page = await connect(t.webSocketDebuggerUrl);
  page.targetId = t.id;
  if (t.id !== targetId) saveSession({ targetId: t.id });
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  return page;
}

const SESSION = path.join(os.tmpdir(), 'cah-real-session.json');
function saveSession(o) { fs.writeFileSync(SESSION, JSON.stringify(o, null, 2)); }
function loadSession() {
  return fs.existsSync(SESSION) ? JSON.parse(fs.readFileSync(SESSION, 'utf8')) : {};
}

if (require.main === module) (async () => {
  const step = process.argv[2] || 'open';

  if (step === 'open') {
    const { page, targetId } = await openPage(COZE_URL);
    console.log('等待页面渲染...');
    await sleep(9000);
    const ctx = await classifyContexts(page);
    console.log('\n顶层上下文:', ctx.top.length, '| iframe 上下文:', ctx.frames.length);
    for (const c of ctx.top.concat(ctx.frames)) {
      console.log(`  #${c.ctxId} ${c.isTop ? 'top  ' : 'frame'} ext=${c.hasExt} ta=${c.textareas} panel=${c.panel} build=${c.build || '-'}`);
    }
    const frame = ctx.frames.find((c) => c.hasExt) || ctx.frames[0];
    if (frame) {
      const st = await tryEval(
        page,
        `({ url: location.href,
            values: [...document.querySelectorAll('textarea')].map(t => ({ id: t.id, val: t.value })),
            text: document.body ? document.body.innerText.slice(0, 250) : '' })`,
        frame.ctxId
      );
      console.log('\niframe 内容:', JSON.stringify(st, null, 1));
    }
    await shot(page, 'real-flow-open.png');
    saveSession({ targetId });
    console.log('\ntargetId:', targetId);
  }

  if (step === 'login') {
    const sess = loadSession();
    const page = await attach(sess.targetId);
    await sleep(1500);
    const ctx = await classifyContexts(page);
    const frame = ctx.frames.find((c) => c.hasExt) || ctx.frames[0];
    if (!frame) {
      console.log('没有 iframe，当前可能已在答题页。上下文:');
      for (const c of ctx.top) console.log(`  #${c.ctxId} top ta=${c.textareas} text=`, (await tryEval(page, 'document.body.innerText.slice(0,150)', c.ctxId)));
      process.exit(0);
    }
    const r = await tryEval(
      page,
      `(() => {
        const btn = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '登录');
        if (!btn) return 'no-login-button';
        if (btn.disabled) return 'button-disabled';
        btn.click();
        return 'clicked';
      })()`,
      frame.ctxId
    );
    console.log('点击登录:', r);
    await sleep(6000);
    const after = await classifyContexts(page);
    console.log('\n登录后上下文: top=' + after.top.length + ' frames=' + after.frames.length);
    for (const c of after.top.concat(after.frames)) {
      const txt = await tryEval(page, 'document.body ? document.body.innerText.slice(0,200) : ""', c.ctxId);
      console.log(`  #${c.ctxId} ${c.isTop ? 'top' : 'frame'} ta=${c.textareas}`);
      if (txt) console.log('    ' + String(txt).replace(/\n/g, ' | ').slice(0, 200));
    }
    await shot(page, 'real-flow-login.png');
  }

  if (step === 'quiz') {
    const sess = loadSession();
    const page = await attach(sess.targetId);
    await page.send('Page.bringToFront');
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await sleep(1200);
    let ctx = await classifyContexts(page);
    let frame = ctx.frames.find((c) => c.hasExt) || ctx.frames[0];
    if (!frame) { console.log('没有 iframe'); process.exit(0); }

    // 1) 打开知识点下拉。Coze 用自定义组件，JS click 不足以触发，
    //    改用 CDP 原生鼠标事件，坐标 = iframe 视口位置 + 元素在 iframe 内的位置。
    const rel = await tryEval(page, `(() => {
      const btn = document.querySelector('button[role="combobox"]');
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), open: btn.getAttribute('aria-expanded') === 'true' };
    })()`, frame.ctxId);

    const frameRect = await tryEval(page, `(() => {
      const f = document.querySelector('iframe');
      if (!f) return null;
      const r = f.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    })()`, ctx.top.find((c) => c.hasExt) ? ctx.top.find((c) => c.hasExt).ctxId : ctx.top[0].ctxId);

    console.log('元素在 iframe 内:', JSON.stringify(rel), '| iframe 视口位置:', JSON.stringify(frameRect));
    if (rel && frameRect && !rel.open) {
      const X = rel.x + frameRect.x, Y = rel.y + frameRect.y;
      console.log('点击坐标:', X, Y);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X, y: Y });
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: X, y: Y, button: 'left', clickCount: 1 });
      await sleep(60);
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X, y: Y, button: 'left', clickCount: 1 });
    }
    await sleep(2000);

    // 2) 列出选项（可能渲染在 body 末尾的 portal 里）
    const opts = await tryEval(page, `(() => {
      const nodes = [...document.querySelectorAll('[role="option"], .semi-select-option, li, [class*="option" i]')];
      return nodes.filter(n => {
        const r = n.getBoundingClientRect();
        return r.height > 0 && n.innerText.trim();
      }).map(n => { const r = n.getBoundingClientRect(); return { text: n.innerText.trim().slice(0, 50), cls: (n.className||'').toString().slice(0, 40), x: r.left + r.width/2, y: r.top + r.height/2 }; }).slice(0, 20);
    })()`, frame.ctxId);
    console.log('可见选项:', JSON.stringify(opts, null, 1));
    await shot(page, 'real-flow-dropdown.png');

    // 3) 选第一个
    if (opts && opts.length) {
      // Radix Select commits on pointerup; DOM element.click() does not select.
      const x = frameRect.x + opts[0].x, y = frameRect.y + opts[0].y;
      await page.send('Input.dispatchMouseEvent', { type:'mouseMoved', x, y });
      await page.send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
      await page.send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
      console.log('选择:', opts[0].text);
      await sleep(1500);

      // 4) 点开始答题
      const started = await tryEval(page, `(() => {
        const btn = [...document.querySelectorAll('button')].find(b => /开始答题/.test(b.innerText));
        if (!btn) return 'no-start';
        if (btn.disabled) return 'start-disabled';
        btn.click();
        return 'started';
      })()`, frame.ctxId);
      console.log('开始答题:', started);
      if (started !== 'started') throw new Error('选择知识点后未能开始答题: ' + started);
      await sleep(6000);
    } else throw new Error('没有识别到可选择的知识点');

    ctx = await classifyContexts(page);
    frame = ctx.frames.find((c) => c.hasExt) || ctx.frames[0];
    const after = await tryEval(page, `({
      url: location.href,
      textareas: [...document.querySelectorAll('textarea')].map(t => ({ id: t.id, val: t.value.slice(0,30) })),
      text: document.body ? document.body.innerText.slice(0, 500) : ''
    })`, frame ? frame.ctxId : null);
    console.log('=== 当前页面 ===');
    console.log(JSON.stringify(after, null, 1));
    await shot(page, 'real-flow-quiz.png');
    process.exit(0);
  }

  if (step === 'probe') {
    const sess = loadSession();
    const page = await attach(sess.targetId);
    await sleep(2000);
    const ctx = await classifyContexts(page);
    const targets = ctx.frames.filter((c) => c.hasExt).concat(ctx.top.filter((c) => c.hasExt));
    if (!targets.length) throw new Error('页面未检测到扩展，请刷新扩展和 Coze 页面');
    console.log('用于诊断的上下文:', targets.map((t) => '#' + t.ctxId + (t.isTop ? '(top)' : '(frame)')).join(', '));
    const diagnostics = [];
    for (const c of targets) {
      const diag = await tryEval(page, `(() => {
        if (typeof __CAH__ === 'undefined' || !__CAH__.detect) return null;
        return __CAH__.detect.diagnose();
      })()`, c.ctxId);
      if (diag && !diag.__err) {
        diagnostics.push({ isTop: c.isTop, diagnosis: diag });
        console.log('\n=== 诊断 #' + c.ctxId + ' ===');
        console.log(JSON.stringify(diag, null, 1));
      }
    }
    if (!diagnostics.length) throw new Error('没有取得有效诊断');
    fs.mkdirSync(OUTPUT, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT, 'real-probe.json'), redact(JSON.stringify({
      checkedAt: new Date().toISOString(), diagnostics
    }, null, 2)));
    await shot(page, 'real-flow-probe.png');
  }

  for (const ws of connections) ws.close();
  process.exit(0);
})().catch((e) => {
  console.error('错误:', e.message);
  for (const ws of connections) ws.close();
  process.exit(1);
});

module.exports = { PORT, ROOT, OUTPUT, COZE_URL, getJson, connect, tryEval, classifyContexts, attach, loadSession, shot, redact, sleep, connections };
