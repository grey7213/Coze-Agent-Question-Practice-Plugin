/* 用无头 Chrome（CDP）跑集成测试：
   - 打开 tests/mock-coze.html
   - 注入扩展的 core 脚本（不经 chrome.* API）
   - 用桩 askAI 驱动引擎，验证识别→填写→发送→回「是」→下一题
   - 同时验证「失败不发送」「选择器失效回退」等边界
   用法: node tests/run-test.js
*/
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error('未找到 Chrome');
  process.exit(1);
}

function serve(port) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, urlPath === '/' ? '/tests/mock-coze.html' : urlPath);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(file);
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
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
  return ws;
}

async function connect() {
  // 先取 /json/version，再连 browser target 建新页面
  const version = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  const browser = new CDP(ws);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const targets = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
  const t = targets.find((x) => x.id === targetId);
  const pageWs = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    pageWs.addEventListener('open', r, { once: true });
    pageWs.addEventListener('error', j, { once: true });
  });
  return { browser, page: new CDP(pageWs), targetId };
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

const WEB_PORT = 8123;
const CDP_PORT = 9333;
let chrome;
let headless;

async function main() {
  const server = await serve(WEB_PORT);
  headless = path.join(os.tmpdir(), 'cah-headless');

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=' + CDP_PORT + '',
    '--port=' + CDP_PORT,
    '--user-data-dir=' + headless,
    'about:blank'
  ];
  chrome = spawn(CHROME, args, { stdio: 'ignore' });

  // 等端口就绪
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      await getJson('http://127.0.0.1:' + CDP_PORT + '/json/version');
      break;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  const session = await connect();
  const { page } = session;
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  const errors = [];
  page.ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value || a.description).join(' '));
    }
  });

  await page.send('Page.navigate', { url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-coze.html' });
  await new Promise((r) => setTimeout(r, 900));

  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + detail : ''));
  };

  const evaluate = async (expr) => {
    const r = await page.send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ': ' + (r.exceptionDetails.exception?.description || ''));
    return r.result.value;
  };

  // 注入 core 脚本（用 Page.addScriptToEvaluateOnNewDocument 之外的直接求值即可）
  const coreFiles = ['src/shared/defaults.js', 'src/core/util.js', 'src/core/detect.js', 'src/core/fill.js', 'src/core/engine.js'];
  for (const f of coreFiles) {
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.join(ROOT, f), 'utf8') });
  }
  await page.send('Page.reload');
  await new Promise((r) => setTimeout(r, 900));

  check('核心脚本加载', await evaluate('!!(window.__CAH__ && __CAH__.Engine && __CAH__.detect)'));
  check(
    '识别消息列表',
    await evaluate('__CAH__.detect.getMessageRows(__CAH__.detect.findMessageList()).length >= 2'),
    'rows=' + (await evaluate('__CAH__.detect.getMessageRows(__CAH__.detect.findMessageList()).length'))
  );
  check('识别输入框', await evaluate('!!__CAH__.detect.findInput()'), await evaluate('(e=>e&&e.id) (__CAH__.detect.findInput())'));
  check(
    '识别发送按钮',
    await evaluate('!!__CAH__.detect.findSendButton(__CAH__.detect.findInput())'),
    await evaluate('(s=>s&&s.el.ariaLabel) (__CAH__.detect.findSendButton(__CAH__.detect.findInput()))')
  );

  // 填写校验
  const fillCheck = await evaluate(`(async () => {
    const input = __CAH__.detect.findInput();
    const r = await __CAH__.fill.fill(input, 'A');
    return { ok: r.ok, actual: r.actual, reason: r.reason || '' };
  })()`);
  check('contenteditable 写入 + 回读', fillCheck.ok, JSON.stringify(fillCheck));

  // 端到端：引擎 + 桩 askAI
  const runResult = await evaluate(`(async () => {
    const events = [];
    let calls = 0;
    const settings = __CAH__.defaults.withDefaults({
      autoGenerate: true, autoFill: true, requireConfirm: false, autoAdvance: true,
      stabilizeMs: 300, actionDelayMs: 50, maxRounds: 5, apiKey: 'x'
    });
    const engine = new __CAH__.Engine({
      settings,
      askAI: async (p) => { calls++; return { ok: true, answer: 'A', explanation: 'stub' }; },
      emit: (ev, d) => events.push(ev + (d && d.state ? ':' + d.state : ''))
    });
    engine.start();
    await new Promise(r => setTimeout(r, 9000));
    engine.stop();
    return {
      calls,
      events: events.slice(0, 40),
      finished: window.__mock.finished,
      log: window.__mock.log.map(s => s.slice(0, 30))
    };
  })()`);

  console.log('  events:', runResult.events.join(' → '));
  console.log('  mock log:', runResult.log.join(' | '));
  check('至少生成一次答案', runResult.calls >= 1, 'calls=' + runResult.calls);
  check('自动发送了答案', runResult.events.includes('sent'), '');
  check('自动回复了「是」', runResult.log.some((x) => x.startsWith('me: 是')), '');
  check('走到了下一题', runResult.calls >= 2, 'calls=' + runResult.calls);
  check('无页面异常', errors.length === 0, errors.slice(0, 3).join(' | '));

  // 边界：写入失败不发送
  const fakeQuestion = '第 9 题（单选）测试\nA. 甲\nB. 乙';
  const guard = await evaluate(`(async () => {
    const settings = __CAH__.defaults.withDefaults({ autoGenerate: true, autoFill: true, requireConfirm: false, autoAdvance: true, stabilizeMs: 200, apiKey: 'x' });
    const engine = new __CAH__.Engine({ settings, askAI: async () => ({ ok: true, answer: 'A' }), emit: () => {} });
    engine.resolveInput = () => null;
    engine.question = ${JSON.stringify(fakeQuestion)};
    await engine.sendAnswer('A', {});
    return engine.state;
  })()`);
  check('找不到输入框时不发送并报错', guard === 'error', 'state=' + guard);

  // 回归：开启「发送前确认」且用户不点时，不能反复调用模型。
  // 必须换一个干净页面，否则上一轮用例的消息会污染列表。
  const { browser: browserCli } = session;
  const { targetId: freshId } = await browserCli.send('Target.createTarget', {
    url: 'http://127.0.0.1:' + WEB_PORT + '/tests/mock-coze.html?case=idempotent'
  });
  let freshTarget;
  for (let i = 0; i < 40; i++) {
    const ts = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
    freshTarget = ts.find((x) => x.id === freshId);
    if (freshTarget && /mock-coze/.test(freshTarget.url)) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const fresh = new CDP(await openWs(freshTarget.webSocketDebuggerUrl));
  await fresh.send('Runtime.enable');
  await fresh.send('Page.enable');
  // 新页面也要注入 core 脚本
  for (const f of coreFiles) {
    await fresh.send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.join(ROOT, f), 'utf8') });
  }
  await fresh.send('Page.reload');
  await new Promise((r) => setTimeout(r, 1200));

  const evaluateFresh = async (expr) => {
    const r = await fresh.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };

  const idempotent = await evaluateFresh(`(async () => {
    const settings = __CAH__.defaults.withDefaults({
      autoGenerate: true, autoFill: true, requireConfirm: true, autoAdvance: false,
      stabilizeMs: 200, actionDelayMs: 20, maxRounds: 50, apiKey: 'x'
    });
    let calls = 0;
    const engine = new __CAH__.Engine({
      settings,
      askAI: async () => { calls++; return { ok: true, answer: 'A', explanation: 'stub' }; },
      emit: () => {}
    });
    engine.start();
    await new Promise(r => setTimeout(r, 6000));
    engine.stop();
    return { calls, state: engine.state, q: engine.question.slice(0, 30) };
  })()`);
  check('确认模式下不重复调用模型', idempotent.calls === 1, JSON.stringify(idempotent));

  // 真实 Coze 的题型格式与判分反馈识别
  const classify = await evaluateFresh(`(() => {
    const C = __CAH__.classify;
    const cozeQuestion = [
      '考查知识点：【Java 基础 - 变量、标识符、基本数据类型、运算符】',
      '【单选题】(2 分):',
      '下列运算符中，属于算术运算符的是哪一项？',
      'A: &&; B: =; C: +; D: =='
    ].join('\\n');
    const feedback = [
      '你的回答是: 是',
      '正确答案: B',
      '你的答题结果是: 错误',
      '本题得分: 0',
      '错因分析: 你对 Java 自定义标识符的命名规则掌握不牢。'
    ].join('\\n');
    const advance = '是否继续下一题？回复「是」。';
    return {
      cozeQuestion: C.looksLikeQuestion(cozeQuestion),
      feedbackAsQuestion: C.looksLikeQuestion(feedback),
      feedbackAsContinue: C.isContinuePrompt(feedback, C.buildPatterns({})),
      feedbackFlag: C.isFeedback(feedback),
      advance: C.isContinuePrompt(advance, C.buildPatterns({})),
      echoYes: C.isAdvanceEcho('是', { advanceText: '是' }),
      echoOk: C.isAdvanceEcho('A. final', { advanceText: '是' })
    };
  })()`);
  check('识别 Coze 题型格式', classify.cozeQuestion === true, JSON.stringify(classify.cozeQuestion));
  check('判分反馈不当成题目', classify.feedbackAsQuestion === false && classify.feedbackFlag === true);
  check('判分反馈不当成继续提示', classify.feedbackAsContinue === false);
  check('继续提示仍能识别', classify.advance === true);
  check('拦截「是」当答案', classify.echoYes === true && classify.echoOk === false, JSON.stringify([classify.echoYes, classify.echoOk]));

  // 端到端护栏：模型若返回「是」，必须报错而不是发送
  const echoGuard = await evaluateFresh(`(async () => {
    const settings = __CAH__.defaults.withDefaults({
      autoGenerate: true, autoFill: true, requireConfirm: false, autoAdvance: false,
      stabilizeMs: 200, apiKey: 'x', maxRounds: 3
    });
    const engine = new __CAH__.Engine({
      settings,
      askAI: async () => ({ ok: true, answer: '是', explanation: 'stub' }),
      emit: () => {}
    });
    engine.question = '第 1 题（单选）测试\\nA. 甲\\nB. 乙';
    await engine.generate({ manual: true });
    return { state: engine.state, answer: engine.answer, err: engine.lastError };
  })()`);
  check('模型返回进阶词时拦截不发', echoGuard.state === 'error' && echoGuard.answer === '', JSON.stringify(echoGuard));

  const lifecycle = await evaluateFresh(fs.readFileSync(path.join(__dirname, 'lifecycle-cases.js'), 'utf8'));
  for (const result of lifecycle) check(result.name, result.ok, JSON.stringify(result.detail));

  const failed = results.filter((r) => !r.ok);
  const evidenceDir = path.join(ROOT, 'output', 'tests', 'latest');
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path.join(evidenceDir, 'core-cases.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), passed: results.length - failed.length,
    total: results.length, results
  }, null, 2));
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
  server.close();
  chrome.kill();
  await cleanupDir(headless);
  process.exit(failed.length ? 1 : 0);
}

async function cleanupDir(dir) {
  // Chrome 退出后文件句柄可能还没释放，重试几次；失败不影响测试结果
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e) {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

main().catch(async (e) => {
  console.error(e);
  if (chrome) chrome.kill();
  if (headless) await cleanupDir(headless);
  process.exit(1);
});
