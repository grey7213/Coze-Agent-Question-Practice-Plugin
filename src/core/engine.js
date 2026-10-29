/* 状态机：稳定检测 → 识别题目 → 生成答案 → 填写 → 发送 → 处理「继续」提示 */
(function () {
  const CAH = (globalThis.__CAH__ = globalThis.__CAH__ || {});
  const U = CAH.util;
  const D = CAH.detect;
  const F = CAH.fill;

  const CONTINUE_PATTERNS = [
    /回复\s*[「“"']?是[」”"']?/,
    /是否(继续|进入下一题|开始下一题)/,
    /继续下一题/,
    /要继续吗/,
    /(输入|回复)\s*[「“"']?(继续|next|yes)[」”"']/i,
    /say\s+(yes|next)/i
  ];
  // 「下一题：……」是题目而不是继续提示，需要排除
  const CONCRETE_QUESTION_HINT = [
    /第\s*\d+\s*题/,
    /请(回答|选择|填写|判断)/,
    /^[\s（(]*[A-Da-d][.、)）:：]\s*\S/m,
    /(单选|多选|判断|填空|简答)题/,
    /考查知识点/,
    /\(\s*\d+\s*分\s*\)|（\s*\d+\s*分\s*）/
  ];
  const QUESTION_HINT = [/[?？]\s*$/m].concat(CONCRETE_QUESTION_HINT);

  // 判分反馈 / 成绩播报：出现这些说明对方在讲评，不是在出题
  const FEEDBACK_HINT = [
    /你的答案/,
    /正确答案/,
    /你的答题结果/,
    /本题得分/,
    /错因分析/,
    /本题考察/,
    /本题考查/
  ];

  // 页面噪音：页脚声明、纯操作按钮、裸 JSON。这些既不是题目也不是继续提示。
  const NOISE_PATTERNS = [
    /内容由\s*AI\s*生成/,
    /无法确保真实准确/,
    /仅供参考/,
    /^(查看排行|返回上一页|进入下一题|上一题|下一题|提交答案|退出|分享|收藏|点赞)$/,
    /^\s*$/,
    /^复制$/,
    /^详细$/,
    /^配置项$/
  ];

  /**
   * 明显不是对话内容的行。
   * 注意：裸 JSON 只用于「不当作题目」，它内部可能含有进阶提示文字，
   * 所以 pickTargetMessage 里会单独处理，不能一概当噪音丢掉。
   */
  function isNoise(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    if (t.length > 4000) return false;
    return NOISE_PATTERNS.some((r) => r.test(t));
  }

  /** Coze 有时把插件返回值原样渲染成一行 JSON */
  function isRawJson(text) {
    return /^\s*\{\s*"(output|result|data|message|content)"\s*:/.test(String(text || '').trim());
  }

  /** 这是一条判分反馈，不应当被当成题目或继续提示 */
  function isFeedback(text) {
    const t = text || '';
    // Real grading messages quote the full previous question and its options.
    // Those quoted options do not turn a score report back into a new question.
    return FEEDBACK_HINT.some((r) => r.test(t));
  }

  /** 答案只是「是 / 继续 / yes」这类进阶词 —— 一定不是真正的题目答案 */
  function isAdvanceEcho(answer, settings) {
    const a = String(answer || '').replace(/[\s。.!！,，、"'“”「」]/g, '');
    if (!a) return false;
    const advance = String((settings && settings.advanceText) || '是').replace(/\s/g, '');
    const set = new Set([advance, '是', '是的', '继续', 'next', 'yes', 'ok', '好的', '好']);
    return a.length <= 6 && set.has(a.toLowerCase()) === true || (a.length <= 5 && (a === advance || a === '是'));
  }

  function looksLikeQuestion(text) {
    const t = text || '';
    if (t.length < 6) return false;
    if (isFeedback(t)) return false;
    if (isContinuePrompt(t, CONTINUE_PATTERNS)) return false;
    if (QUESTION_HINT.some((r) => r.test(t))) return true;
    // 有选项行也算
    const optionLines = (t.match(/^\s*[A-Da-d][.、)）]\s+/gm) || []).length;
    return optionLines >= 2;
  }

  function isContinuePrompt(text, patterns) {
    const t = text || '';
    if (!t || t.length > 400) return false;
    if (isFeedback(t)) return false;
    // A question mark alone is not a quiz: "是否继续下一题？" and the
    // onboarding prompt both require confirmation, not an LLM answer.
    if (CONCRETE_QUESTION_HINT.some((r) => r.test(t))) return false;
    return isStartPrompt(t) || (patterns || CONTINUE_PATTERNS).some((r) => r.test(t));
  }

  function isStartPrompt(text) {
    const t = String(text || '');
    if (!t || t.length > 400 || isFeedback(t) || CONCRETE_QUESTION_HINT.some(r => r.test(t))) return false;
    return /准备好\s*(?:开始)?\s*(?:答题|作答|练习)(?:了)?(?:吗|么|嘛)/.test(t) ||
      /是否(?:已经)?准备好(?:开始)?(?:答题|作答|练习)/.test(t);
  }

  function buildPatterns(settings) {
    const extra = String(settings.advancePatterns || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        try {
          return new RegExp(s, 'i');
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
    return CONTINUE_PATTERNS.concat(extra);
  }

  class Engine {
    constructor(opts) {
      this.settings = opts.settings;
      this.askAI = opts.askAI || (async () => ({ ok: false, error: '未配置模型' }));
      this.emit = opts.emit || (() => {});
      this.inspectMessages = opts.inspectMessages || (() => false);
      this.running = false;
      this.busy = false;
      this.timer = null;
      this.tickInterval = 700;

      this.state = 'idle'; // idle|running|generating|ready|sending|waiting|advance_ready|error
      this.question = '';
      this.answer = '';
      this.explanation = '';
      this.lastError = '';
      this.rounds = 0;
      this.history = []; // {role:'me'|'them', text}

      this.lastRowText = '';
      this.lastRowKey = '';
      this.lastRowSince = 0;
      this.handledKey = '';
      this.lastSentKey = '';
      this.ownTexts = new Map(); // hash -> time
      this.pendingAdvance = false;
      this.bound = { list: null, input: null, send: null };
      this.actionVersion = 0;
      this.generation = null;
      this.sendLock = null;
      this.answerContext = null;
    }

    setSettings(s) {
      this.settings = s;
      this.emit('settings');
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.lastError = '';
      const hasDraft = this.answer && this.handledKey !== this.lastSentKey &&
        (!this.answerContext || this.contextIsCurrent(this.answerContext));
      this.setState(hasDraft ? (this.pendingAdvance ? 'advance_ready' : 'ready') : 'running');
      this.timer = setInterval(() => this.tick(), this.tickInterval);
      this.tick();
    }

    stop() {
      const wasGenerating = !!this.generation;
      this.cancelPending();
      // A cancelled request may be tried again after Start. Completed drafts
      // remain available for explicit confirmation, without resuming auto-send.
      if (wasGenerating && !this.answer) this.handledKey = '';
      this.running = false;
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.setState('idle');
    }

    setState(s, extra) {
      this.state = s;
      this.emit('state', Object.assign({ state: s }, extra || {}));
    }

    reset() {
      this.cancelPending();
      this.handledKey = '';
      this.lastSentKey = '';
      this.lastRowText = '';
      this.lastRowKey = '';
      this.lastRowSince = 0;
      this.question = '';
      this.answer = '';
      this.explanation = '';
      this.rounds = 0;
      this.lastError = '';
      this.pendingAdvance = false;
      this.answerContext = null;
      this.history = [];
      this.ownTexts.clear();
      this.setState(this.running ? 'running' : 'idle');
    }

    skip() {
      const last = this.pickTargetMessage(this.readMessages());
      this.cancelPending();
      this.handledKey = last ? this.messageKey(last) : this.handledKey;
      this.lastRowKey = this.handledKey;
      this.lastRowText = last ? last.text : this.lastRowText;
      this.lastRowSince = Date.now();
      this.question = '';
      this.answer = '';
      this.explanation = '';
      this.lastError = '';
      this.pendingAdvance = false;
      this.answerContext = null;
      this.setState(this.running ? 'running' : 'idle');
    }

    cancelPending() {
      this.actionVersion++;
      this.generation = null;
      this.busy = false;
      if (this.answerContext) {
        this.answerContext = Object.assign({}, this.answerContext, { version: this.actionVersion });
      }
    }

    messageKey(message) {
      if (!message) return '';
      const id = message.el && message.el.getAttribute('data-message-id');
      return (id ? id + ':' : '') + U.hash(U.norm(message.text));
    }

    captureContext() {
      return {
        version: this.actionVersion, key: this.handledKey,
        question: this.question, input: this.resolveInput()
      };
    }

    contextIsCurrent(context) {
      if (context.version !== this.actionVersion) return false;
      const current = context.key ? this.pickTargetMessage(this.readMessages()) : null;
      const changed = context.key !== this.handledKey || context.question !== this.question ||
        (context.key && this.messageKey(current) !== context.key) ||
        (context.input && (!context.input.isConnected || context.input !== this.resolveInput()));
      if (!changed) return true;
      // A SPA can replace the question/composer while an API request is pending.
      // Discard its result and let the normal stability check find the new page.
      this.cancelPending();
      this.question = '';
      this.answer = '';
      this.explanation = '';
      this.lastError = '';
      this.handledKey = '';
      this.lastRowKey = '';
      this.lastRowText = '';
      this.pendingAdvance = false;
      this.answerContext = null;
      this.setState(this.running ? 'running' : 'idle', { ignored: '页面已变化，等待重新识别' });
      return false;
    }

    // ---------- DOM 解析 ----------

    resolveList() {
      const custom = U.queryPath(this.settings.overrides.messageList);
      if (custom) return custom;
      return D.findMessageList();
    }

    resolveInput() {
      const custom = U.queryPath(this.settings.overrides.input);
      if (custom && D.isEditable(custom)) return custom;
      return D.findInput();
    }

    readMessages() {
      const list = this.resolveList();
      const rows = D.getMessageRows(list);
      return rows.map((row) => ({ el: row, text: D.messageText(row) })).filter((m) => m.text);
    }

    isOwnMessage(text, row) {
      const role = D.messageRole(row);
      if (role) return role === 'user';
      return this.ownTexts.has(U.hash(U.norm(text)));
    }

    // ---------- 主循环 ----------

    async tick() {
      if (!this.running || this.busy || this.sendLock) return;
      if (this.state === 'generating' || this.state === 'sending') return;
      try {
        const msgs = this.readMessages();
        if (!msgs.length) return;
        const latest = msgs.slice().reverse().find(m => this.isOwnMessage(m.text, m.el) || !isNoise(m.text));
        if (latest && D.messageFailed(latest.el)) {
          this.stop();
          this.fail('Coze 显示消息发送失败。请在原消息旁点击“重新发送”，收到回复后再点“开始”。');
          return;
        }
        if (this.inspectMessages(msgs)) return;
        this.history = msgs.slice(-12).map((m) => ({
          role: this.isOwnMessage(m.text, m.el) ? 'me' : 'them',
          text: m.text
        }));

        // 从后往前找「真正需要处理的那条」。
        // Coze 的聊天卡片下面可能挂着页脚（"内容由AI生成，无法确保真实准确"），
        // 它也是一行文字，但绝不是题目。只看最后一条会被它挡住。
        const last = this.pickTargetMessage(msgs);
        if (!last) return;

        const key = this.messageKey(last);
        if (key !== this.handledKey) {
          if (key !== this.lastRowKey) {
            this.lastRowKey = key;
            this.lastRowText = last.text;
            this.lastRowSince = Date.now();
            this.emit('preview', { text: last.text.slice(0, 300) });
            return;
          }
        }

        const stableFor = Date.now() - this.lastRowSince;
        if (stableFor < this.settings.stabilizeMs) return;
        // 同一条消息只处理一次。生成失败不会自动重试，避免持续计费；
        // 需要重试时由用户点面板上的「生成」。
        if (key === this.handledKey) return;

        // 稳定且未处理
        this.handleStableMessage(last.text, key);
      } catch (e) {
        this.fail('扫描页面出错: ' + e.message);
      }
    }

    /**
     * 只跳过页脚和纯按钮。最新本人消息、反馈、结束语都是对话边界，
     * 不能越过这些消息，重新执行历史中的题目或「继续」提示。
     *
     * 裸 JSON 行（Coze 把插件返回值原样渲染）不当作题目，但如果它内含
     * 进阶提示（"可回复是"），仍按继续提示处理——否则会漏掉一轮。
     */
    pickTargetMessage(msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        const text = m.text;
        if (!text) continue;
        if (this.isOwnMessage(text, m.el)) return null;
        if (isNoise(text)) continue;
        return m;
      }
      return null;
    }

    handleStableMessage(text, key) {
      const patterns = buildPatterns(this.settings);
      this.lastError = '';
      this.answerContext = null;
      if (isContinuePrompt(text, patterns)) {
        this.handledKey = key;
        this.pendingAdvance = true;
        this.question = text.slice(0, 400);
        this.answer = this.settings.advanceText || '是';
        this.explanation = isStartPrompt(text) ? '检测到开场确认，发送「' + this.answer + '」开始答题' : '检测到继续提示';
        this.answerContext = this.captureContext();
        this.emit('advance', { text: this.question, answer: this.answer });
        this.setState('advance_ready');
        // 自动进阶默认关闭，发送前确认默认开启。
        // 只有用户显式关掉确认、并且显式打开自动进阶，才自动发。
        if (this.settings.autoAdvance && !this.settings.requireConfirm) {
          this.sendAnswer(this.answer, { reason: 'auto-advance' });
        }
        return;
      }

      if (isFeedback(text)) {
        this.handledKey = key;
        this.question = '';
        this.answer = '';
        this.explanation = '';
        this.pendingAdvance = false;
        this.setState('running', { ignored: '判分反馈' });
        return;
      }

      if (isRawJson(text) || !looksLikeQuestion(text)) {
        this.handledKey = key;
        this.question = '';
        this.answer = '';
        this.explanation = '';
        this.pendingAdvance = false;
        this.setState('running', { ignored: text.slice(0, 80) });
        return;
      }

      this.handledKey = key;
      this.pendingAdvance = false;
      this.question = text;
      this.answer = '';
      this.explanation = '';
      this.emit('question', { text });
      if (this.settings.autoGenerate) this.generate();
      else this.setState('ready', { needsGenerate: true });
    }

    async generate(opts) {
      if (this.busy || this.sendLock) return;
      if (!this.question) {
        this.fail('还没有识别到题目');
        return;
      }
      if (this.rounds >= this.settings.maxRounds) {
        this.stop();
        this.fail('已达到最大轮数 ' + this.settings.maxRounds + '，已停止。');
        return;
      }
      const context = this.captureContext();
      if (!this.contextIsCurrent(context)) return;
      const generation = { context };
      this.generation = generation;
      this.busy = true;
      this.lastError = '';
      this.setState('generating');
      try {
        const res = await this.askAI({
          question: this.question,
          history: this.history,
          systemPrompt: this.settings.systemPrompt
        });
        if (!this.contextIsCurrent(context)) return;
        if (!res || !res.ok) {
          this.fail((res && res.error) || '生成失败');
          return;
        }
        const answer = String(res.answer == null ? '' : res.answer).trim();
        if (!answer) {
          this.fail('模型未返回有效答案');
          return;
        }
        // 护栏：模型返回的若只是进阶词，说明它把「继续提示」当题目在答。
        // 这种答案绝不能发出去——它会被平台当成对题目的正式作答。
        if (isAdvanceEcho(answer, this.settings)) {
          this.fail('模型返回的是进阶词（' + answer.slice(0, 10) + '），不是题目答案，已拦截。请检查是否把继续提示误判为题目。');
          return;
        }
        this.answer = answer;
        this.answerContext = context;
        this.explanation = res.explanation || '';
        this.emit('answer', { answer: this.answer, explanation: this.explanation });
        if (this.settings.autoFill) {
          const input = this.resolveInput();
          const r = await F.fill(input, this.answer);
          if (!this.contextIsCurrent(context)) return;
          if (!r.ok) {
            this.fail('写入输入框失败：' + r.reason);
            return;
          }
          this.emit('filled', { actual: r.actual });
        }
        if (!this.settings.requireConfirm && this.settings.autoFill) {
          await U.sleep(this.settings.actionDelayMs);
          if (!this.contextIsCurrent(context)) return;
          if (!this.settings.requireConfirm && this.settings.autoFill) {
            await this.sendAnswer(this.answer, { reason: 'auto' });
          } else this.setState('ready');
        } else {
          this.setState('ready');
        }
      } catch (e) {
        if (context.version === this.actionVersion) this.fail('生成过程异常: ' + e.message);
      } finally {
        if (this.generation === generation) {
          this.generation = null;
          this.busy = false;
        }
      }
    }

    /** 用户点「生成」按钮 */
    async regenerate() {
      if (this.busy || this.sendLock) return;
      if (this.pendingAdvance) {
        this.setState('advance_ready');
        return;
      }
      this.answer = '';
      this.explanation = '';
      await this.generate({ manual: true });
    }

    /** 用户点「发送」 */
    async sendCurrent() {
      if (this.sendLock || this.state === 'sending' || this.state === 'generating') return;
      if (this.handledKey && this.handledKey === this.lastSentKey) return;
      if (!this.answer) {
        this.fail('还没有答案可发送');
        return;
      }
      await this.sendAnswer(this.answer, { reason: 'manual' });
    }

    async sendAnswer(text, meta) {
      if (this.sendLock || this.state === 'sending') return;
      if (this.handledKey && this.handledKey === this.lastSentKey) return;
      if (this.rounds >= this.settings.maxRounds) {
        this.stop();
        this.fail('已达到最大轮数 ' + this.settings.maxRounds + '，已停止。');
        return;
      }
      // Lock before the first await: a second click must not race with filling.
      const lock = {};
      this.sendLock = lock;
      const context = this.answerContext || this.captureContext();
      try {
        if (!this.contextIsCurrent(context)) return;
        const input = this.resolveInput();
        if (!input) {
          this.fail('未找到输入框');
          return;
        }
        if (!String(text || '').trim()) {
          this.fail('没有有效答案可发送');
          return;
        }
        this.lastError = '';
        if (!F.sameText(F.readBack(input), text)) {
          const r = await F.fill(input, text);
          if (!this.contextIsCurrent(context)) return;
          if (!r.ok) {
            this.fail('写入失败：' + r.reason);
            return;
          }
        }
        if (!this.contextIsCurrent(context)) return;
        const reason = meta && meta.reason;
        if ((reason === 'auto' && (this.settings.requireConfirm || !this.settings.autoFill)) ||
            (reason === 'auto-advance' && (this.settings.requireConfirm || !this.settings.autoAdvance))) {
          this.setState(this.pendingAdvance ? 'advance_ready' : 'ready');
          return;
        }
        if (!F.sameText(F.readBack(input), text)) {
          this.fail('发送前输入框内容与完整答案不一致');
          return;
        }
        this.setState('sending');
        const send = this.resolveSend();
        // An attempted submission must not be retried automatically while its
        // outcome is unknown. The user can inspect the page and reset explicitly.
        this.lastSentKey = this.handledKey;
        let clicked = false;
        if (send && !send.disabled) clicked = F.click(send.el);
        if (!clicked) {
          input.focus();
          F.pressEnter(input);
        }
        const cleared = await U.waitFor(() =>
          input.isConnected && F.readBack(input).trim() === '', 2500, 120);
        if (context.version !== this.actionVersion) return;
        if (!cleared) {
          this.fail('点击发送后输入框未清空，可能没有发送成功。请手动检查。');
          return;
        }
        this.ownTexts.set(U.hash(U.norm(text)), Date.now());
        this.history.push({ role: 'me', text });
        this.rounds += 1;
        this.pendingAdvance = false;
        this.answerContext = null;
        this.emit('sent', { text, meta: meta || {} });
        this.setState('waiting');
      } catch (e) {
        if (context.version === this.actionVersion) this.fail('发送过程异常: ' + e.message);
      } finally {
        if (this.sendLock === lock) this.sendLock = null;
      }
    }

    resolveSend() {
      const custom = U.queryPath(this.settings.overrides.sendButton);
      if (custom && U.isVisible(custom)) return { el: custom, disabled: U.isDisabled(custom) };
      const input = this.resolveInput();
      return D.findSendButton(input);
    }

    fail(msg) {
      this.lastError = msg;
      this.setState('error', { error: msg });
    }

    /** 供面板显示 */
    snapshot() {
      return {
        state: this.state,
        question: this.question,
        answer: this.answer,
        explanation: this.explanation,
        error: this.lastError,
        rounds: this.rounds,
        autoAdvance: this.settings.autoAdvance,
        autoSwitchChapter: this.settings.autoSwitchChapter,
        requireConfirm: this.settings.requireConfirm,
        pendingAdvance: this.pendingAdvance,
        chapter: this.chapter || null
      };
    }
  }

  CAH.Engine = Engine;
  CAH.classify = { looksLikeQuestion, isContinuePrompt, isStartPrompt, isFeedback, isAdvanceEcho, isNoise, isRawJson, buildPatterns };
})();
