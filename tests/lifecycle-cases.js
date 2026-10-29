/* Executed by run-test.js inside real Chrome, using the actual Engine and fill
   modules. All form data, questions and model replies are synthetic. */
(async () => {
  const C = __CAH__;
  const results = [];
  const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
  };
  const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail });
  let sequence = 0;
  function fixture(overrides = {}) {
    const host = document.createElement('section');
    const row = document.createElement('p');
    row.dataset.messageId = 'lifecycle-' + (++sequence);
    row.textContent = '第 21 题（单选）：哪一项正确？\nA. 选项甲\nB. 选项乙';
    const input = document.createElement('textarea');
    const button = document.createElement('button');
    button.textContent = '发送测试答案';
    host.append(row, input, button);
    document.body.append(host);
    const f = { host, row, input, button, sent: [], clicks: 0, events: [] };
    f.engine = new C.Engine({
      settings: C.defaults.withDefaults({
        requireConfirm: true, autoAdvance: false, autoFill: true,
        stabilizeMs: 50, actionDelayMs: 10, ...overrides
      }),
      askAI: async () => ({ ok: true, answer: 'A' }),
      emit: (event, data) => f.events.push({ event, data })
    });
    const e = f.engine;
    e.resolveInput = () => f.input;
    e.resolveSend = () => ({ el: button, disabled: button.disabled });
    e.readMessages = () => [{ el: row, text: row.textContent }];
    e.question = row.textContent;
    e.handledKey = row.dataset.messageId + ':' + C.util.hash(C.util.norm(row.textContent));
    e.lastRowText = row.textContent;
    e.lastRowSince = Date.now() - 1000;
    e.running = true;
    button.addEventListener('click', () => {
      f.clicks++;
      if (f.onSend) return f.onSend();
      f.sent.push(f.input.value);
      f.input.value = '';
      row.dataset.messageId += '-reply';
      row.textContent = '等待模拟回复';
    });
    f.dispose = () => { e.stop(); host.remove(); };
    return f;
  }
  const state = f => ({
    state: f.engine.state, answer: f.engine.answer, input: f.input.value,
    rounds: f.engine.rounds, busy: f.engine.busy, sent: f.sent,
    clicks: f.clicks, error: f.engine.lastError
  });

  {
    const f = fixture({ requireConfirm: false });
    const d = deferred();
    f.engine.askAI = () => d.promise;
    const job = f.engine.generate();
    f.engine.stop();
    d.resolve({ ok: true, answer: 'A' });
    await job;
    check('暂停后晚到的模型结果不填写、不发送', f.engine.state === 'idle' &&
      f.input.value === '' && f.sent.length === 0 && f.engine.answer === '', state(f));
    f.dispose();
  }

  {
    const f = fixture({ requireConfirm: false });
    const d = deferred();
    f.engine.askAI = () => d.promise;
    const job = f.engine.generate();
    f.engine.reset();
    d.resolve({ ok: true, answer: 'A' });
    await job;
    check('重置后旧模型结果不恢复答案和轮数', f.engine.answer === '' &&
      f.engine.rounds === 0 && f.input.value === '' && f.sent.length === 0, state(f));
    f.dispose();
  }

  {
    const f = fixture();
    const old = deferred(), current = deferred();
    let calls = 0;
    f.engine.askAI = () => (++calls === 1 ? old.promise : current.promise);
    const oldJob = f.engine.generate();
    f.engine.stop();
    f.engine.start();
    const newJob = f.engine.regenerate();
    old.resolve({ ok: true, answer: 'A' });
    await oldJob;
    check('重新生成时旧请求不清除新请求的忙碌状态', calls === 2 &&
      f.engine.busy && f.engine.state === 'generating' && f.input.value === '', state(f));
    current.resolve({ ok: true, answer: 'B' });
    await newJob;
    check('暂停后可重新生成并保留新答案', calls === 2 && f.input.value === 'B' &&
      f.engine.answer === 'B' && f.engine.state === 'ready' && !f.engine.busy, state(f));
    f.dispose();
  }

  {
    const f = fixture({ requireConfirm: false, actionDelayMs: 160 });
    const job = f.engine.generate();
    await C.util.waitFor(() => f.input.value === 'A', 1000, 5);
    f.engine.stop();
    await job;
    check('填写或延迟期间暂停会取消自动发送', f.engine.state === 'idle' &&
      f.sent.length === 0 && f.engine.rounds === 0, state(f));
    f.dispose();
  }

  {
    const f = fixture();
    const d = deferred();
    f.engine.askAI = () => d.promise;
    const job = f.engine.generate();
    f.row.dataset.messageId += '-new';
    f.row.textContent = '第 22 题（判断）：Java 可以跨平台吗？';
    d.resolve({ ok: true, answer: 'A' });
    await job;
    check('模型返回前换题不会填写旧题答案', f.input.value === '' &&
      f.engine.answer === '' && f.sent.length === 0, state(f));
    f.dispose();
  }

  {
    const f = fixture();
    const d = deferred();
    f.engine.askAI = () => d.promise;
    const job = f.engine.generate();
    const replacement = f.input.cloneNode();
    f.input.replaceWith(replacement);
    f.input = replacement;
    d.resolve({ ok: true, answer: 'A' });
    await job;
    check('输入框被替换时旧模型结果失效', f.input.value === '' &&
      f.engine.answer === '' && f.sent.length === 0, state(f));
    f.dispose();
  }

  {
    const f = fixture();
    await f.engine.generate();
    f.row.dataset.messageId += '-next';
    f.row.textContent = '第 23 题（判断）：这是一道新的测试题。';
    await f.engine.sendCurrent();
    check('确认发送前换题不会提交旧答案', f.sent.length === 0 &&
      f.engine.rounds === 0, state(f));
    f.dispose();
  }

  {
    const f = fixture();
    f.input.addEventListener('input', () => { f.input.value = f.input.value.slice(0, 12); });
    const written = await C.fill.fill(f.input, 'abcdefghijklmnopqrstuv');
    check('完整回读拦截只保留前十二个字符的答案', !written.ok, written);
    f.dispose();
  }

  {
    const f = fixture();
    f.input.addEventListener('input', () => { f.input.value = f.input.value.replace('a b', 'ab'); });
    const written = await C.fill.fill(f.input, 'String name = "a b";');
    check('回读保留代码字符串内部空格语义', !written.ok, written);
    f.dispose();
  }

  {
    const f = fixture({ requireConfirm: false });
    f.input.addEventListener('input', () => { f.input.value = f.input.value.slice(0, 12); });
    f.engine.askAI = async () => ({ ok: true, answer: 'abcdefghijklmnopqrstuv' });
    await f.engine.generate();
    check('长答案被截断时不会点击发送', f.engine.state === 'error' &&
      f.clicks === 0 && f.engine.rounds === 0, state(f));
    f.dispose();
  }

  {
    const f = fixture();
    f.engine.answer = 'A';
    f.engine.state = 'ready';
    await Promise.all([f.engine.sendCurrent(), f.engine.sendCurrent()]);
    check('空输入框连点发送只提交一次且不产生伪错误', f.sent.length === 1 &&
      f.engine.rounds === 1 && f.engine.state === 'waiting' && !f.engine.lastError, state(f));
    f.dispose();
  }

  {
    const f = fixture();
    f.engine.answer = 'A';
    f.engine.state = 'ready';
    f.onSend = () => { f.input.value = 'A（仍未发送）'; };
    await f.engine.sendCurrent();
    check('发送后内容改变但未清空不计为成功', f.engine.state === 'error' &&
      f.engine.rounds === 0 && !f.events.some(x => x.event === 'sent'), state(f));
    f.dispose();
  }

  {
    const f = fixture();
    const d = deferred();
    f.engine.askAI = () => d.promise;
    const job = f.engine.generate();
    const hasSkip = typeof f.engine.skip === 'function';
    if (hasSkip) f.engine.skip();
    d.resolve({ ok: true, answer: 'A' });
    await job;
    if (hasSkip) await f.engine.tick();
    check('跳过带消息 ID 的题目会取消生成且不会重新处理', hasSkip &&
      f.engine.answer === '' && f.input.value === '' && f.sent.length === 0 &&
      f.engine.state === 'running', state(f));
    f.dispose();
  }

  {
    const f = fixture({ requireConfirm: false, actionDelayMs: 160 });
    const job = f.engine.generate();
    await C.util.waitFor(() => f.input.value === 'A', 1000, 5);
    f.engine.setSettings({ ...f.engine.settings, requireConfirm: true });
    await job;
    check('填写期间重新开启确认会取消自动发送', f.engine.state === 'ready' &&
      f.input.value === 'A' && f.sent.length === 0, state(f));
    f.dispose();
  }

  {
    const f = fixture();
    await f.engine.generate();
    f.engine.stop();
    f.engine.start();
    check('暂停后的完整草稿可恢复为待确认状态', f.engine.state === 'ready' &&
      f.engine.answer === 'A' && f.input.value === 'A' && f.sent.length === 0, state(f));
    await f.engine.sendCurrent();
    check('恢复草稿后可手动确认发送一次', f.sent.length === 1 &&
      f.sent[0] === 'A' && f.engine.rounds === 1, state(f));
    f.dispose();
  }

  {
    const f = fixture();
    f.engine.answer = 'A';
    f.engine.state = 'ready';
    f.input.value = 'a';
    await f.engine.sendCurrent();
    check('发送前校验不会忽略答案大小写变化', f.sent[0] === 'A', state(f));
    f.dispose();
  }

  {
    const f = fixture({ requireConfirm: false, autoAdvance: true, maxRounds: 1 });
    f.engine.rounds = 1;
    f.engine.answer = '是';
    f.engine.pendingAdvance = true;
    await f.engine.sendAnswer('是', { reason: 'auto-advance' });
    check('自动进阶同样遵守最大轮数', f.sent.length === 0 &&
      f.engine.rounds === 1 && !f.engine.running && f.engine.state === 'error', state(f));
    f.dispose();
  }

  return results;
})()
