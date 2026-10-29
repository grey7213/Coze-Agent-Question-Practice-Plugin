/* iframe 场景端到端测试：
   顶层是空壳（只有导航文字），真正的内容在 iframe 里。
   验证顶层下发的命令能到达 iframe 里的引擎。

   用法: node tests/run-iframe.js
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

const WEB_PORT = 8141;
const CDP_PORT = 9351;
const TMP = path.join(os.tmpdir(), 'cah-iframe');
const EXT = path.join(TMP, 'ext');
const PROFILE = path.join(TMP, 'profile');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const mfPath = path.join(EXT, 'manifest.json');
  const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
  mf.host_permissions = ['http://127.0.0.1/*'];
  mf.content_scripts[0].matches.push('http://127.0.0.1/*');
  fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));
}

function serve() {
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(req.url.split('?')[0]);
    const f = path.join(ROOT, p === '/' ? '/tests/mock-coze-iframe.html' : p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) {
      res.writeHead(404);
      res.end('nf');
      return;
    }
    res.writeHead(200, {
      'content-type': f.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8'
    });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => server.listen(WEB_PORT, '127.0.0.1', () => r(server)));
}

const getJson = (u) =>
  new Promise((resolve, reject) =>
    http
      .get(u, (x) => {
        let d = '';
        x.on('data', (c) => (d += c));
        x.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      })
      .on('error', reject)
  );

async function waitJson(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { return await getJson(url); } catch (e) { await sleep(200); }
  }
  throw new Error('等待超时: ' + url);
}

const MODEL_ANSWER = 'A';
let modelCalls = 0;

async function openWs(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const c = { id: 0, pending: new Map(), contexts: [], destroyed: new Set() };
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && c.pending.has(m.id)) {
      const { resolve, reject } = c.pending.get(m.id);
      c.pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method === 'Runtime.executionContextCreated') {
      c.contexts.push(m.params.context);
    } else if (m.method === 'Runtime.executionContextDestroyed') {
      c.contexts = c.contexts.filter((x) => x.id !== m.params.executionContextId);
      c.destroyed.add(m.params.executionContextId);
    }
  });
  c.send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++c.id;
      c.pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  return c;
}

async function ev(page, expr, ctx) {
  const p = { expression: expr, awaitPromise: true, returnByValue: true };
  if (ctx) p.contextId = ctx;
  try {
    const r = await page.send('Runtime.evaluate', p);
    if (r.exceptionDetails) return { __err: r.exceptionDetails.text };
    return r.result.value;
  } catch (e) {
    return null;
  }
}

async function cleanup(dir) {
  for (let i = 0; i < 6; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch (e) { await sleep(400); }
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

  // mock 模型接口
  const model = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        modelCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '答案: ' + MODEL_ANSWER + '\n解析: stub' } }]
        }));
      });
      return;
    }
    res.writeHead(404); res.end('nf');
  });
  await new Promise((r) => model.listen(8142, '127.0.0.1', r));

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

    // 配置
    const { targetId: optId } = await browser.send('Target.createTarget', {
      url: 'chrome-extension://' + extId + '/src/options/options.html'
    });
    let opt;
    for (let i = 0; i < 40; i++) {
      const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      opt = ts.find((x) => x.id === optId);
      if (opt) break;
      await sleep(150);
    }
    const optPage = await openWs(opt.webSocketDebuggerUrl);
    await optPage.send('Runtime.enable');
    await sleep(500);

    const settings = {
      provider: 'openai',
      baseUrl: 'http://127.0.0.1:8142/v1',
      apiKey: 'test',
      model: 'mock',
      autoGenerate: true, autoFill: true, requireConfirm: false, autoAdvance: true,
      stabilizeMs: 300, actionDelayMs: 50, maxRounds: 6,
      overrides: { messageList: '', input: '', sendButton: '' },
      loginStudentId: '', loginName: '', autoLogin: false, loginAutoSubmit: false
    };
    await ev(optPage, `new Promise(r => chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }, r))`);
    check('配置写入', true);

    // 打开 iframe 页面
    const { targetId } = await browser.send('Target.createTarget', {
      url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-coze-iframe.html'
    });
    let pt;
    for (let i = 0; i < 40; i++) {
      const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
      pt = ts.find((x) => x.id === targetId);
      if (pt && /mock-coze-iframe/.test(pt.url)) break;
      await sleep(150);
    }
    const page = await openWs(pt.webSocketDebuggerUrl);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await sleep(3500);

    // 上下文分类：顶层有面板但无输入；iframe 内有输入（textarea 或 contenteditable）
    let top = null;
    let frame = null;
    for (const c of page.contexts) {
      const info = await ev(page, `({
        isTop: window.top === window,
        ta: document.querySelectorAll('textarea').length,
        edit: document.querySelectorAll('[contenteditable="true"]').length,
        panel: !!document.getElementById('cah-panel-host'),
        build: typeof __CAH__ !== 'undefined' ? __CAH__.BUILD : null
      })`, c.id);
      if (!info || info.__err) continue;
      if (info.isTop && info.panel) top = { id: c.id, ...info };
      if (!info.isTop && (info.ta > 0 || info.edit > 0)) frame = { id: c.id, ...info };
    }
    check('顶层有面板但无输入框', !!top && top.ta === 0 && top.edit === 0, JSON.stringify(top));
    check('iframe 内有输入框', !!frame, JSON.stringify(frame));
    check('构建号一致', top && frame && top.build === frame.build, (top && top.build) + ' / ' + (frame && frame.build));

    // 等 bus 握手 + 选中 frame（子 frame 会多次宣告）
    await sleep(5000);

    // 顶层的诊断应来自子 frame
    await ev(page, `(() => {
      const h = document.getElementById('cah-panel-host');
      [...h.shadowRoot.querySelectorAll('button')].find(b => b.textContent.trim() === '诊断').click();
      return true;
    })()`, top.id);
    await sleep(2500);
    const diagText = await ev(page, `(() => {
      const h = document.getElementById('cah-panel-host');
      return h.shadowRoot.querySelector('.diag') ? h.shadowRoot.querySelector('.diag').textContent : '';
    })()`, top.id);
    check('诊断来自子 frame', /来源: 子 frame/.test(diagText), (diagText || '').slice(0, 120).replace(/\n/g, ' | '));
    check('诊断能看到输入框', /【输入框】/.test(diagText) && !/【输入框】未找到/.test(diagText), (diagText.match(/【输入框】[^\n]*/) || [''])[0]);

    // 点「开始」，命令应下发到 iframe
    await ev(page, `(() => {
      const h = document.getElementById('cah-panel-host');
      [...h.shadowRoot.querySelectorAll('button')].find(b => b.textContent.trim() === '开始').click();
      return true;
    })()`, top.id);

    await sleep(10000);

    // __mock 在页面主世界，不在扩展隔离世界，所以要用「非扩展」的那份 iframe 上下文
    let mainFrame = null;
    for (const c of page.contexts) {
      const ok = await ev(page, `window.top !== window && !!window.__mock`, c.id);
      if (ok === true) { mainFrame = c.id; break; }
    }
    const readCtx = mainFrame || frame.id;
    const innerLog = await ev(page, `window.__mock ? window.__mock.log.slice() : null`, readCtx);
    const innerFinished = await ev(page, `window.__mock ? window.__mock.finished : null`, readCtx);
    console.log('  读取上下文:', readCtx, '(主世界 iframe:', mainFrame, ')');
    console.log('  iframe 内日志:', (innerLog || []).join(' | '));
    console.log('  模型调用次数:', modelCalls);

    check('顶层「开始」触发了 iframe 引擎', (innerLog || []).length > 0, JSON.stringify((innerLog || []).slice(0, 3)));
    check('iframe 内实际发送了答案', (innerLog || []).some((x) => x.startsWith('me: ')), JSON.stringify((innerLog || []).filter((x) => x.startsWith('me:'))));
    check('模型被调用', modelCalls >= 1, 'calls=' + modelCalls);
    check('自动回「是」', (innerLog || []).includes('me: 是'));
    check('走到最后一题', innerFinished === true);

    // 面板状态应同步到顶层
    const title = await ev(page, `(() => {
      const h = document.getElementById('cah-panel-host');
      return h.shadowRoot.querySelector('header .title').textContent;
    })()`, top.id);
    check('顶层面板反映子 frame 状态', /监听中|等待|待发送/.test(title), title);

    // The store shell survives navigation, but the app iframe is replaced. Its new
    // conversation has fewer rows than the old one, so row count cannot keep the
    // destroyed frame selected forever.
    await ev(optPage, `chrome.storage.local.set({ settings: ${JSON.stringify({ ...settings, requireConfirm: true, autoAdvance: false })} })`);
    await ev(page, `document.querySelector('iframe').src = '/tests/mock-coze-inner.html?case=replaced'`, top.id);
    await sleep(5000);
    await ev(page, `Array.from(document.querySelector('#cah-panel-host').shadowRoot.querySelectorAll('button')).find(b=>b.textContent.trim()==='诊断').click()`, top.id);
    await sleep(1000);
    const replacedDiag = await ev(page, `document.querySelector('#cah-panel-host').shadowRoot.querySelector('.diag').textContent`, top.id);
    const oldFrameId = (diagText.match(/来源: 子 frame (\w+)/) || [])[1];
    const newFrameId = (replacedDiag.match(/来源: 子 frame (\w+)/) || [])[1];
    check('iframe 换页后诊断切换到新目标', !!newFrameId && newFrameId !== oldFrameId && !/未收到/.test(replacedDiag));

    await ev(page, `Array.from(document.querySelector('#cah-panel-host').shadowRoot.querySelectorAll('button')).find(b=>b.textContent.trim()==='开始').click()`, top.id);
    await sleep(3000);
    // __mock belongs to the iframe's main world, not the extension's isolated world.
    const replacementContext = page.contexts.findLast(c => c.auxData?.isDefault && c.auxData.frameId !== targetId);
    const replacedFlow = await ev(page, `({
      filled:document.querySelector('#editor').innerText.trim(),
      sent:window.__mock.log.filter(s=>s.startsWith('me:')).length
    })`, replacementContext.id);
    check('换页后顶层按钮仍能生成并只填不发', replacedFlow.filled === 'A' && replacedFlow.sent === 0, JSON.stringify(replacedFlow));

    const { targetId: otherId } = await browser.send('Target.createTarget', { url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-coze-iframe.html?case=other-tab' });
    await sleep(3500);
    const otherTarget = (await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list')).find(t => t.id === otherId);
    const otherPage = await openWs(otherTarget.webSocketDebuggerUrl);
    await otherPage.send('Runtime.enable');
    await ev(page, `Array.from(document.querySelector('#cah-panel-host').shadowRoot.querySelectorAll('button')).find(b=>b.textContent.trim()==='诊断').click()`, top.id);
    await sleep(1000);
    const otherState = await ev(otherPage, `(() => {
      const root=document.querySelector('#cah-panel-host').shadowRoot;
      return {question:root.querySelector('.q').textContent,diagnosis:root.querySelector('.diag').textContent};
    })()`);
    check('同源多个标签页的 frame 消息互不干扰', otherState.question === '' && otherState.diagnosis === '');

    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(ROOT, 'specs', 'iframe-panel.png'), Buffer.from(shot.data, 'base64'));
  } catch (e) {
    check('测试执行', false, e.message);
  } finally {
    const failed = results.filter((r) => !r.ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
    server.close();
    model.close();
    chrome.kill();
    await cleanup(TMP);
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
