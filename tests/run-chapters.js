/* Local Chrome/MV3 chapter navigation and iframe binding regression.
   No Coze or configured model requests. node tests/run-chapters.js */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output/tests/latest');
const SHOTS = path.join(ROOT, 'output/playwright');
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')
].find(file => fs.existsSync(file));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const clients = [];
const modelCalls = [];
let browser, optionsPage, chrome, server, temp, baseUrl;
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  — ' + JSON.stringify(detail) : ''));
}
async function until(read, name, timeout = 12000) {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await sleep(60);
  } while (Date.now() < deadline);
  throw new Error('等待超时：' + name);
}
async function json(url) {
  return (await fetch(url, { signal: AbortSignal.timeout(3000) })).json();
}
class Client {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.contexts = new Map();
    this.errors = [];
    ws.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method === 'Runtime.executionContextCreated') {
        this.contexts.set(message.params.context.id, message.params.context);
      } else if (message.method === 'Runtime.executionContextDestroyed') {
        this.contexts.delete(message.params.executionContextId);
      } else if (message.method === 'Runtime.executionContextsCleared') this.contexts.clear();
      else if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('CDP 超时：' + method));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, contextId) {
    const result = await this.send('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  close() {
    for (const task of this.pending.values()) { clearTimeout(task.timer); task.reject(new Error('CDP closed')); }
    this.pending.clear();
    this.ws.close();
  }
}
async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const client = new Client(ws);
  clients.push(client);
  return client;
}
const expression = (fn, data) => '(' + fn.toString() + ')(' + JSON.stringify(data ?? null) + ')';
const top = (page, fn, data) => page.evaluate(expression(fn, data));
async function frame(page, fn, data) {
  const contextId = await until(async () => {
    for (const context of [...page.contexts.values()].reverse()) {
      if (context.auxData?.isDefault) continue;
      try {
        if (await page.evaluate('window.top !== window && !!globalThis.__CAH__?.__test__', context.id)) return context.id;
      } catch (_) {}
    }
    return null;
  }, '内容 iframe');
  return page.evaluate(expression(fn, data), contextId);
}
async function pageAt(url) {
  const { targetId } = await browser.send('Target.createTarget', { url });
  const target = await until(async () => (await json(baseUrl + '/json/list')).find(item => item.id === targetId), '浏览器标签页');
  const page = await connect(target.webSocketDebuggerUrl);
  page.targetId = targetId;
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  return page;
}
async function course(query = '', app = '100001') {
  const page = await pageAt(server.origin + '/store/project/' + app + '?' + query);
  await until(() => top(page, () => !!document.querySelector('#cah-panel-host')?.shadowRoot), '浮动面板');
  await frame(page, () => !!__CAH__.__test__.chapters);
  await until(() => top(page, () => !!document.querySelector('iframe')?.contentDocument?.querySelector('#course textarea,#course [role="combobox"],#course select')), '课程控件');
  return page;
}
async function closePage(page) {
  await browser.send('Target.closeTarget', { targetId: page.targetId });
  page.close();
}
async function clickPanel(page, label) {
  await until(() => top(page, text => {
    const button = [...document.querySelector('#cah-panel-host').shadowRoot.querySelectorAll('button')].find(el => el.textContent.trim() === text);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, label), '面板按钮 ' + label);
}
const snapshot = page => frame(page, () => __CAH__.__test__.engine.snapshot());
const events = page => top(page, () => fixture.events);
async function ready(page, topic) {
  await until(async () => {
    try {
      const state = await snapshot(page);
      return state.state === 'ready' && state.question.includes(topic);
    } catch (_) { return false; }
  }, '新题已填写 ' + topic, 16000);
}
async function screenshot(page, name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(SHOTS, name), Buffer.from(shot.data, 'base64'));
}
async function configure(patch) {
  await optionsPage.evaluate('chrome.storage.local.get("settings").then(got => chrome.storage.local.set({settings:Object.assign({},got.settings,' + JSON.stringify(patch) + ')}))');
}
async function scenario(name, run) {
  try { await run(); } catch (error) { check(name, false, error.message); }
}
function copySource(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name), to = path.join(destination, entry.name);
    if (entry.isDirectory()) copySource(from, to);
    else fs.copyFileSync(from, to);
  }
}
async function start() {
  if (!CHROME) throw new Error('未找到 Chrome');
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cah-chapters-'));
  const extension = path.join(temp, 'ext');
  const profile = path.join(temp, 'profile');
  fs.mkdirSync(extension);
  fs.mkdirSync(profile);
  copySource(path.join(ROOT, 'src'), path.join(extension, 'src'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  manifest.content_scripts[0].matches.push('http://127.0.0.1/*');
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
  server = http.createServer((request, response) => {
    if (request.method === 'POST' && request.url === '/v1/chat/completions') {
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => {
        const text = JSON.parse(body).messages.at(-1).content;
        const topic = [...text.matchAll(/考查知识点：【([^】]+)】/g)].at(-1)?.[1] || '';
        const answer = topic.includes('方法') ? 'C' : topic.includes('循环') ? 'B' : 'A';
        modelCalls.push({ topic, answer });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: [{ message: { content: '答案: ' + answer + '\n解析: 本地回归答案' } }] }));
      });
      return;
    }
    const pathname = request.url.split('?')[0];
    const file = pathname.startsWith('/store/project/') ? 'mock-chapters.html' :
      pathname.startsWith('/ui-builder-app/') ? 'mock-chapters-inner.html' : null;
    if (!file) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(fs.readFileSync(path.join(__dirname, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.origin = 'http://127.0.0.1:' + server.address().port;
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-extension-debugging', '--remote-debugging-port=0', '--user-data-dir=' + profile,
    '--window-size=1280,900', 'about:blank'
  ], { stdio: 'ignore', windowsHide: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  await until(() => fs.existsSync(portFile), 'Chrome CDP', 20000);
  baseUrl = 'http://127.0.0.1:' + fs.readFileSync(portFile, 'utf8').split('\n')[0].trim();
  const version = await json(baseUrl + '/json/version');
  browser = await connect(version.webSocketDebuggerUrl);
  const { id } = await browser.send('Extensions.loadUnpacked', { path: extension });
  optionsPage = await pageAt('chrome-extension://' + id + '/src/options/options.html');
  await until(() => top(optionsPage, () => !!document.getElementById('autoSwitchChapter')), '章节设置项');
  await configure({
    provider: 'openai', baseUrl: server.origin + '/v1', apiKey: 'fixture-only-key', model: 'mock',
    autoGenerate: true, autoFill: true, requireConfirm: true, autoAdvance: false, autoSwitchChapter: true,
    autoLogin: false, loginAutoSubmit: false, stabilizeMs: 300, actionDelayMs: 20, maxRounds: 20,
    overrides: { messageList: '', input: '', sendButton: '' }
  });
}

async function pureCases() {
  const page = await course('grade=question');
  const cases = await frame(page, () => {
    const C = __CAH__, P = C.chapters;
    const rows = [];
    const add = (name, ok) => rows.push({ name, ok });
    const score = '你的答题结果是：正确\n本题得分：0\n本题考查的知识点：Java 基础 - if 判断、switch';
    add('正确零分反馈解析', P.parseFeedback(score).correct && P.parseFeedback(score).gained === 0);
    add('错误零分保持错误', !P.parseFeedback(score.replace('是：正确', '是：错误')).correct);
    add('正分识别', P.parseFeedback(score.replace('得分：0', '得分：2')).gained === 2);
    add('缺失分值保持未知', P.parseFeedback(score.replace('\n本题得分：0', '')).gained === null);
    add('新增积分优先于题面得分', P.parseFeedback(score.replace('得分：0', '得分：2') + '\n新增积分：0').gained === 0);
    add('JSON 判分包装可解析', P.parseFeedback(JSON.stringify({ output: score })).gained === 0);
    add('资源点不足不是判分', P.parseFeedback('资源点余额不足，请等待额度刷新或升级到专业版') === null);
    add('资源与登录错误明确识别', !!P.platformError('资源点余额不足') && !!P.platformError('请重新登录'));
    add('知识点名称归一化', P.normalizeTopic('Java 基础 — 循环') === P.normalizeTopic('Java基础-循环'));
    const options = [{ text: 'A' }, { text: 'B', disabled: true }, { text: 'C' }, { text: 'D' }];
    add('排除当前、禁用、已完成选项', P.nextTopic(options, 'A', ['C']).text === 'D');
    add('到末项后从开头选剩余知识点', P.nextTopic(options, 'D', ['C']).text === 'A');
    add('全部可用选项完成后无下一项', P.nextTopic(options, 'D', ['A', 'C']) === null);
    function inspect(texts, settings = {}) {
      const engine = new C.Engine({ settings: C.defaults.withDefaults({ autoGenerate: false, stabilizeMs: 300, ...settings }) });
      engine.running = true;
      const flow = new C.ChapterFlow({ engine });
      let navigations = 0;
      flow.run = () => { navigations++; };
      const messages = texts.map(text => ({ text, el: null }));
      flow.inspectMessages(messages);
      if (flow.candidate) flow.candidate.since -= 7000;
      flow.inspectMessages(messages);
      return { navigations, state: engine.state, running: engine.running };
    }
    add('稳定正确零分触发切换', inspect([score]).navigations === 1);
    add('错误零分不切换', inspect([score.replace('是：正确', '是：错误')]).navigations === 0);
    add('正分不切换', inspect([score.replace('得分：0', '得分：2')]).navigations === 0);
    add('缺失分值等待结束后不切换', inspect([score.replace('\n本题得分：0', '')]).navigations === 0);
    add('关闭换章开关不切换', inspect([score], { autoSwitchChapter: false }).navigations === 0);
    add('新题阻断历史零分回扫', inspect([score, '考查知识点：【Java 基础 - 循环】\n第 2 题：请选择正确选项？']).navigations === 0);
    add('结束消息阻断历史零分回扫', inspect([score, '所有练习已经完成，感谢参与。']).navigations === 0);
    add('继续提示前的本轮判分可触发', inspect([score, '是否继续？回复“是”。']).navigations === 1);
    const blocked = inspect(['资源点余额不足，请等待额度刷新或升级到专业版']);
    add('平台错误暂停且不切章', blocked.navigations === 0 && blocked.state === 'error' && !blocked.running);
    return rows;
  });
  cases.forEach(row => check(row.name, row.ok));
  check('新构建注入与安全默认值', await frame(page, () => /#14/.test(__CAH__.BUILD) &&
    __CAH__.defaults.withDefaults({}).requireConfirm === true && __CAH__.defaults.withDefaults({}).autoAdvance === false));
  await closePage(page);
}

async function navigationCases() {
  const page = await course();
  await clickPanel(page, '开始');
  await ready(page, '循环');
  let state = await snapshot(page);
  let log = await events(page);
  check('封顶后返回并选择下一个可用知识点', log.filter(x => x.name === 'back').length === 1 &&
    log.some(x => x.name === 'select' && x.topic === 'loop') && !log.some(x => x.topic === 'array'));
  const filled = await top(page, () => document.querySelector('iframe').contentDocument.querySelector('textarea').value);
  check('新章节经扩展后台生成并填入', state.answer === 'B' && filled === state.answer);
  check('换章后仍等待人工确认', state.requireConfirm && !state.autoAdvance && !log.some(x => x.name === 'send'));
  check('顶层面板显示章节与完成数', await top(page, () => /循环/.test(document.querySelector('#cah-panel-host').shadowRoot.querySelector('.chapter').textContent) &&
    /已完成 1 个/.test(document.querySelector('#cah-panel-host').shadowRoot.querySelector('.chapter').textContent)));
  await screenshot(page, 'chapters-confirmed-fill-14.png');
  await clickPanel(page, '发送');
  await ready(page, '方法');
  check('连续封顶继续下一章且不重选完成章节', (await events(page)).filter(x => x.name === 'select').map(x => x.topic).join(',') === 'loop,method');
  await clickPanel(page, '发送');
  await until(async () => (await snapshot(page)).state === 'chapters_complete', '全部知识点完成');
  state = await snapshot(page);
  log = await events(page);
  check('全部可用知识点完成后停止', state.chapter.completed.length === 3 && state.rounds === 2 &&
    log.filter(x => x.name === 'start').length === 2 && !await frame(page, () => __CAH__.__test__.engine.running));
  check('章节完成记录不包含禁用项', state.chapter.completed.every(text => !text.includes('数组')));
  await screenshot(page, 'chapters-complete-14.png');
  await page.send('Page.reload');
  await until(async () => {
    try { return (await snapshot(page)).state === 'chapters_complete'; } catch (_) { return false; }
  }, '刷新后完成状态');
  check('刷新页面保留全部完成停止状态', !await frame(page, () => __CAH__.__test__.engine.running));
  await closePage(page);
}

async function interruptionCases() {
  const page = await course('navigation=iframe&backDelay=1100');
  await clickPanel(page, '开始');
  await until(async () => (await events(page)).some(x => x.name === 'back'), '返回按钮');
  await clickPanel(page, '暂停');
  await sleep(1400);
  check('暂停中断尚未执行的选项与开始动作', !(await events(page)).some(x => x.name === 'select' || x.name === 'start') &&
    (await snapshot(page)).state === 'idle');
  await clickPanel(page, '开始');
  await ready(page, '循环');
  check('暂停后开始可恢复未完成换章', (await events(page)).filter(x => x.name === 'back').length === 1);
  await closePage(page);

  const starting = await course('questionDelay=1200');
  await clickPanel(starting, '开始');
  await until(async () => (await events(starting)).some(x => x.name === 'start'), '开始加载新题');
  await clickPanel(starting, '暂停');
  await sleep(1400);
  check('等待新题时暂停不生成答案', (await snapshot(starting)).answer === '' && (await snapshot(starting)).state === 'idle');
  await clickPanel(starting, '开始');
  await ready(starting, '循环');
  check('等待新题阶段恢复不再返回上一页', (await events(starting)).filter(x => x.name === 'back').length === 1);
  await closePage(starting);

  const disabled = await course('backDelay=1100');
  await clickPanel(disabled, '开始');
  await until(async () => (await events(disabled)).some(x => x.name === 'back'), '关闭换章开关前的返回');
  await top(disabled, () => {
    const label = [...document.querySelector('#cah-panel-host').shadowRoot.querySelectorAll('label')].find(el => el.textContent.includes('不加分'));
    label.querySelector('input').click();
  });
  await sleep(1400);
  check('切换期间关闭开关立即停止后续动作', !(await events(disabled)).some(x => x.name === 'select') && (await snapshot(disabled)).state === 'idle');
  await top(disabled, () => {
    const doc = document.querySelector('iframe').contentDocument;
    doc.querySelector('[role="combobox"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    [...doc.querySelectorAll('[role="option"]')].find(el => el.textContent.includes('循环')).click();
    doc.querySelector('#start-quiz').click();
  });
  await until(() => top(disabled, () => !!document.querySelector('iframe').contentDocument.querySelector('textarea')), '手动进入新题');
  await clickPanel(disabled, '开始');
  await ready(disabled, '循环');
  check('关闭自动换章后手动选题可继续填写', !await frame(disabled, () => __CAH__.__test__.chapters.progress.needsNavigation));
  await clickPanel(disabled, '发送');
  await until(async () => (await events(disabled)).some(x => x.name === 'send'), '关闭换章后确认发送');
  check('关闭换章开关不阻止人工确认发送', (await events(disabled)).filter(x => x.name === 'send').length === 1);
  await closePage(disabled);
  await configure({ autoSwitchChapter: true });
}

async function boundaryCases() {
  const empty = await course('options=empty');
  await frame(empty, () => { __CAH__.__test__.chapters.navigationTimeoutMs = 600; });
  await clickPanel(empty, '开始');
  await until(async () => (await snapshot(empty)).state === 'error', '空选项报错');
  const state = await snapshot(empty);
  check('空列表报错且不会假报全部完成', /暂无数据|下拉框为空/.test(state.error) && state.chapter.phase === 'error' &&
    !(await events(empty)).some(x => x.name === 'start'));
  await closePage(empty);
  const resource = await course('grade=resource');
  const before = modelCalls.length;
  await clickPanel(resource, '开始');
  await until(async () => (await snapshot(resource)).state === 'error', '平台错误');
  check('真实格式资源不足消息不触发答题或换章', modelCalls.length === before && !(await events(resource)).length &&
    (await snapshot(resource)).chapter.completed.length === 0);
  await closePage(resource);
  const historical = await course('grade=old');
  await clickPanel(historical, '开始');
  await ready(historical, '循环');
  check('完整页面只处理新题而不响应历史封顶', !(await events(historical)).length && (await snapshot(historical)).chapter.completed.length === 0);
  await closePage(historical);
  const native = await course('selector=native');
  await clickPanel(native, '开始');
  await ready(native, '循环');
  check('原生 select 同样可换知识点', (await events(native)).some(x => x.name === 'select' && x.topic === 'loop'));
  await closePage(native);
}

async function iframeCases() {
  const page = await course('navigation=iframe', '200001');
  await frame(page, () => { __CAH__.__test__.engine.rounds = 4; });
  await clickPanel(page, '开始');
  await ready(page, '循环');
  const state = await snapshot(page);
  const log = await events(page);
  check('返回和开始均重建 iframe 后自动恢复', await top(page, () => fixture.replacements === 2) &&
    log.filter(x => x.name === 'back').length === 1 && log.filter(x => x.name === 'start').length === 1);
  check('iframe 恢复保留完成集合与累计轮数', state.rounds === 4 && state.chapter.completed.length === 1 && state.answer === 'B');
  check('恢复时商店顶层不参与章节导航', await top(page, () => document.querySelector('#cah-panel-host').shadowRoot.querySelector('.err').textContent === ''));
  await screenshot(page, 'chapters-iframe-restored-14.png');
  const callsBeforeOther = modelCalls.length;
  const other = await course('grade=question', '200001');
  await sleep(300);
  check('同应用不同标签页进度隔离', (await snapshot(other)).chapter.completed.length === 0 && modelCalls.length === callsBeforeOther);
  await closePage(other);
  await page.send('Page.navigate', { url: server.origin + '/store/project/200002?grade=question' });
  await until(() => top(page, () => location.pathname.includes('200002') && !!document.querySelector('#cah-panel-host')?.shadowRoot), '新应用');
  const otherApp = await snapshot(page);
  check('同标签页不同应用进度隔离', otherApp.chapter.completed.length === 0 && otherApp.rounds === 0);
  const keysSafe = await optionsPage.evaluate('chrome.storage.session.get(null).then(data => Object.values(data).every(value => !("apiKey" in value) && !("loginName" in value) && !("loginStudentId" in value)))');
  check('会话进度不存密钥或学生身份', keysSafe);
  await closePage(page);
}

async function bindingCases() {
  const page = await course('grade=question');
  await top(page, () => document.querySelector('iframe').contentDocument.querySelector('textarea').style.setProperty('outline', '3px dotted rgb(123, 45, 67)', 'important'));
  const outline = await top(page, () => document.querySelector('iframe').contentDocument.querySelector('textarea').style.outline);
  async function point(selector) {
    return top(page, sel => {
      const host = document.querySelector('iframe').getBoundingClientRect();
      const rect = document.querySelector('iframe').contentDocument.querySelector(sel).getBoundingClientRect();
      return { x: host.left + rect.left + 30, y: host.top + rect.top + 22 };
    }, selector);
  }
  await clickPanel(page, '输入框');
  await until(() => top(page, () => !!document.querySelector('iframe').contentDocument.querySelector('#cah-pick-mask')), 'iframe 拾取遮罩');
  check('绑定遮罩位于内容 iframe 且面板暂时隐藏', await top(page, () => !document.querySelector('#cah-pick-mask') &&
    getComputedStyle(document.querySelector('#cah-panel-host')).visibility === 'hidden'));
  const position = await point('textarea');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...position });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position });
  await until(() => top(page, () => document.querySelector('#cah-panel-host').shadowRoot.querySelector('.toast')?.textContent.includes('已绑定')), '绑定成功提示');
  check('真实点选绑定成功且提示回流到顶层', await frame(page, () => __CAH__.__test__.settings.overrides.input === '#answer'));
  check('绑定完成恢复面板和原 outline', await top(page, previous => {
    const input = document.querySelector('iframe').contentDocument.querySelector('textarea');
    return input.style.outline === previous && input.style.getPropertyPriority('outline') === 'important' &&
      getComputedStyle(document.querySelector('#cah-panel-host')).visibility !== 'hidden';
  }, outline));
  await clickPanel(page, '发送按钮');
  await until(() => top(page, () => !!document.querySelector('iframe').contentDocument.querySelector('#cah-pick-mask')), '第二次拾取');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...await point('#submit') });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await until(() => top(page, () => !document.querySelector('iframe').contentDocument.querySelector('#cah-pick-mask')), 'Escape 取消');
  check('Escape 取消拾取且不写入绑定', await frame(page, () => __CAH__.__test__.settings.overrides.sendButton === ''));
  await clickPanel(page, '开始');
  await ready(page, 'if 判断');
  check('绑定后仍能通过扩展生成并填写', (await snapshot(page)).answer === 'A');
  check('拾取与换章无页面运行异常', page.errors.length === 0, page.errors.map(error => error.text));
  await closePage(page);
}

async function main() {
  try {
    await start();
    await scenario('判分单元用例', pureCases);
    await scenario('完整换章链路', navigationCases);
    await scenario('暂停与设置中断', interruptionCases);
    await scenario('边界页面', boundaryCases);
    await scenario('iframe 重建与进度分区', iframeCases);
    await scenario('iframe 绑定交互', bindingCases);
  } catch (error) { check('章节测试启动', false, error.message); }
  finally {
    const failed = results.filter(row => !row.ok);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'chapters-cases.json'), JSON.stringify(results, null, 2));
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
    for (const client of clients) client.close();
    if (chrome) {
      const exited = new Promise(resolve => chrome.once('exit', resolve));
      chrome.kill();
      await Promise.race([exited, sleep(2500)]);
    }
    if (server) { server.closeAllConnections(); server.close(); }
    if (temp && path.dirname(path.resolve(temp)) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('cah-chapters-')) {
      for (let attempt = 0; attempt < 6; attempt++) {
        try { fs.rmSync(temp, { recursive: true, force: true }); break; }
        catch (_) { await sleep(350); }
      }
    }
    process.exitCode = failed.length || !results.length ? 1 : 0;
  }
}
main();
