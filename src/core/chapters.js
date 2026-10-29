/* Chapter quota handling. Operates on visible course feedback and controls;
   never uses the store sidebar's Coze resource balance as a student score. */
(function () {
  const C = (globalThis.__CAH__ = globalThis.__CAH__ || {});
  const U = C.util;
  const F = C.fill;

  function unwrap(text) {
    const value = String(text || '').trim();
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') {
        for (const key of ['output', 'result', 'content', 'message']) {
          if (typeof parsed[key] === 'string') return parsed[key];
        }
      }
    } catch (_) {}
    return value;
  }

  function normalizeTopic(text) {
    return String(text || '').normalize('NFKC').replace(/[—–]/g, '-')
      .replace(/\s+/g, '').toLowerCase();
  }

  function topicOf(text) {
    const match = unwrap(text).match(/(?:考查知识点|本题考查的知识点)\s*[:：]\s*【?([^】\n]+)】?/);
    return match ? match[1].trim() : '';
  }

  function platformError(text) {
    const value = unwrap(text);
    if (value.length > 600 || /【[^】]*题】|本题得分/.test(value)) return '';
    if (/资源点余额不足|资源点(?:已)?(?:耗尽|不足)|账户余额不足|额度(?:已)?耗尽/.test(value)) {
      return 'Coze 资源点不足，已暂停；等待平台额度恢复后再继续。';
    }
    if (/登录(?:状态)?已失效|请重新登录|用户认证失败/.test(value)) {
      return 'Coze 登录已失效，请重新登录后继续。';
    }
    return '';
  }

  function parseFeedback(text) {
    const value = unwrap(text);
    if (platformError(value)) return null;
    const result = value.match(/(?:你的|本次)?(?:答题结果|作答结果)(?:是|为)?\s*[:：]\s*(正确|错误|不正确)/);
    const score = value.match(/(?:本次(?:获得|增加)的?积分|新增积分)\s*[:：]\s*([+-]?\d+(?:\.\d+)?)/) ||
      value.match(/(?:本题得分|本次得分)\s*[:：]\s*([+-]?\d+(?:\.\d+)?)/);
    const explicitCorrect = /(?:回答|作答|答案)正确|答对了/.test(value);
    const explicitWrong = /(?:回答|作答|答案)(?:错误|不正确)|答错了/.test(value);
    if (!result && (!score || (!explicitCorrect && !explicitWrong))) return null;
    const correct = result ? result[1] === '正确' : explicitCorrect && !explicitWrong;
    return { correct, gained: score ? Number(score[1]) : null, topic: topicOf(value) };
  }

  function nextTopic(options, current, completed) {
    const used = new Set((completed || []).map(normalizeTopic));
    if (current) used.add(normalizeTopic(current));
    const currentIndex = options.findIndex(option => normalizeTopic(option.text) === normalizeTopic(current));
    const ordered = currentIndex < 0 ? options : options.slice(currentIndex + 1).concat(options.slice(0, currentIndex + 1));
    return ordered.find(option => !option.disabled && !used.has(normalizeTopic(option.text))) || null;
  }

  const initialProgress = () => ({
    phase: 'idle', navigationStage: '', currentTopic: '', targetTopic: '', completed: [],
    feedbackKey: '', rounds: 0, resume: false, needsNavigation: false, error: ''
  });
  const cancelled = () => Object.assign(new Error('章节操作已取消'), { cancelled: true });

  class ChapterFlow {
    constructor({ engine, load, save, onChange, navigationTimeoutMs = 20000 }) {
      this.engine = engine;
      this.load = load || (async () => null);
      this.save = save || (async () => {});
      this.onChange = onChange || (() => {});
      this.navigationTimeoutMs = navigationTimeoutMs;
      this.progress = initialProgress();
      this.epoch = 0;
      this.busy = false;
      this.candidate = null;
      this.lastFeedbackKey = '';
      this.writes = Promise.resolve();
      this.job = Promise.resolve();
    }

    enabled() { return this.engine.settings.autoSwitchChapter !== false; }

    publish() {
      this.engine.chapter = this.snapshot();
      this.onChange(this.engine.chapter);
    }

    snapshot() {
      return {
        phase: this.progress.phase, currentTopic: this.progress.currentTopic,
        targetTopic: this.progress.targetTopic, completed: this.progress.completed.slice(),
        error: this.progress.error
      };
    }

    check(token) {
      if (token !== this.epoch || !this.enabled()) throw cancelled();
    }

    async commit(patch, token = this.epoch) {
      if (token !== this.epoch) throw cancelled();
      Object.assign(this.progress, patch);
      this.publish();
      const saved = JSON.parse(JSON.stringify(this.progress));
      this.writes = this.writes.catch(() => {}).then(() => this.save(saved));
      await this.writes;
      if (token !== this.epoch) throw cancelled();
    }

    async restore() {
      const token = this.epoch;
      const saved = await this.load();
      if (token !== this.epoch) return;
      if (saved) this.progress = Object.assign(initialProgress(), saved);
      this.engine.rounds = Math.max(this.engine.rounds, this.progress.rounds || 0);
      this.lastFeedbackKey = this.progress.feedbackKey;
      this.publish();
      if (this.progress.phase === 'complete') this.engine.setState('chapters_complete');
      if (this.enabled() && this.progress.resume && this.progress.needsNavigation) this.run();
    }

    findButton(pattern) {
      return [...document.querySelectorAll('button,[role="button"]')].find(el =>
        U.isVisible(el) && !U.isDisabled(el) && pattern.test(U.textOf(el)) && !el.closest('#cah-panel-host')) || null;
    }

    findSelector() {
      return [...document.querySelectorAll('button[role="combobox"],select')].find(el =>
        U.isVisible(el) && !U.isDisabled(el) && !el.closest('#cah-panel-host')) || null;
    }

    options(selector) {
      const nodes = selector.tagName === 'SELECT' ? [...selector.options] :
        [...document.querySelectorAll('[role="option"]')].filter(U.isVisible);
      return nodes.map(el => ({
        el, text: U.textOf(el), disabled: U.isDisabled(el) || el.getAttribute('aria-disabled') === 'true'
      })).filter(option => option.text && !/^(请选择|请从.*选择|暂无数据)/.test(option.text));
    }

    key(element, key) {
      element.focus();
      element.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, composed: true }));
      element.dispatchEvent(new KeyboardEvent('keyup', { key, code: key, bubbles: true, cancelable: true, composed: true }));
    }

    async waitFor(test, message, token, timeout = this.navigationTimeoutMs) {
      const deadline = Date.now() + timeout;
      do {
        this.check(token);
        const result = test();
        if (result) return result;
        await U.sleep(100);
      } while (Date.now() < deadline);
      throw new Error(message);
    }

    inspectMessages(messages) {
      if (this.busy) return true;
      if (!this.engine.running) return false;
      let candidate = null;
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        const text = unwrap(message.text);
        if (!text) continue;
        if (this.engine.isOwnMessage(text, message.el)) return false;
        if (C.classify.isNoise(text)) continue;
        const blocked = platformError(text);
        if (blocked) {
          this.engine.stop();
          this.engine.question = '';
          this.engine.answer = '';
          this.engine.fail(blocked);
          this.commit({ phase: 'error', error: blocked, resume: false }).catch(() => {});
          return true;
        }
        const grade = parseFeedback(text);
        if (grade) { candidate = { message, grade }; break; }
        const topic = topicOf(text);
        if (topic && C.classify.looksLikeQuestion(text)) {
          if (!this.enabled() && this.progress.needsNavigation) {
            this.commit({ currentTopic: topic, targetTopic: '', needsNavigation: false,
              phase: 'answering', navigationStage: '', resume: false, error: '' }).catch(() => {});
          }
          if (this.progress.currentTopic !== topic) {
            this.progress.currentTopic = topic;
            this.publish();
          }
          return false;
        }
        if (C.classify.looksLikeQuestion(text)) return false;
        if (C.classify.isContinuePrompt(text, C.classify.buildPatterns(this.engine.settings))) continue;
        return false;
      }
      if (!this.enabled() || !candidate) return false;
      const { message, grade } = candidate;
      const key = this.engine.messageKey(message);
      if (key === this.lastFeedbackKey || key === this.progress.feedbackKey) return false;
      if (!grade.correct || (grade.gained != null && grade.gained > 0)) {
        this.lastFeedbackKey = key;
        this.candidate = null;
        return false;
      }
      if (!this.candidate || this.candidate.key !== key) this.candidate = { key, since: Date.now() };
      const elapsed = Date.now() - this.candidate.since;
      if (grade.gained == null) {
        if (elapsed < 6000) { this.engine.setState('checking_score'); return true; }
        this.lastFeedbackKey = key;
        return false;
      }
      if (grade.gained !== 0) { this.lastFeedbackKey = key; return false; }
      if (elapsed < Math.max(300, this.engine.settings.stabilizeMs)) {
        this.engine.setState('checking_score');
        return true;
      }
      const topic = grade.topic || this.progress.currentTopic || topicOf(this.engine.question);
      this.lastFeedbackKey = key;
      this.run({ topic, feedbackKey: key });
      return true;
    }

    start() {
      if (this.enabled() && this.progress.phase === 'complete') {
        this.engine.setState('chapters_complete');
        return true;
      }
      if (this.enabled() && this.progress.needsNavigation) { this.run(); return true; }
      return false;
    }

    pause() {
      ++this.epoch;
      this.busy = false;
      this.candidate = null;
      this.commit({ phase: 'paused', resume: false }).catch(() => {});
    }

    abandon() { ++this.epoch; this.busy = false; }

    reset() {
      ++this.epoch;
      this.busy = false;
      this.candidate = null;
      this.lastFeedbackKey = '';
      this.progress = initialProgress();
      this.commit({}).catch(() => {});
    }

    run(completion) {
      if (this.busy || !this.enabled()) return this.job;
      const token = ++this.epoch;
      this.busy = true;
      this.engine.stop();
      this.engine.question = '';
      this.engine.answer = '';
      this.engine.explanation = '';
      this.engine.pendingAdvance = false;
      this.engine.answerContext = null;
      this.engine.setState('switching_chapter');
      this.job = (async () => {
        if (completion) {
          if (!completion.topic) throw new Error('答对且得 0 分，但未识别到知识点名称，请手动选择下一章。');
          const completed = this.progress.completed.slice();
          if (!completed.some(topic => normalizeTopic(topic) === normalizeTopic(completion.topic))) completed.push(completion.topic);
          await this.commit({
            completed, currentTopic: completion.topic, targetTopic: '',
            feedbackKey: completion.feedbackKey, rounds: this.engine.rounds,
            phase: 'returning', navigationStage: 'returning', needsNavigation: true, resume: true, error: ''
          }, token);
        } else await this.commit({ resume: true, error: '' }, token);
        await this.navigate(token);
      })().catch(async error => {
        if (error.cancelled || token !== this.epoch) return;
        this.engine.stop();
        this.engine.fail('切换知识点失败：' + error.message);
        try { await this.commit({ phase: 'error', error: error.message, resume: false }, token); } catch (_) {}
      }).finally(() => { if (token === this.epoch) this.busy = false; });
      return this.job;
    }

    async navigate(token) {
      this.check(token);
      // A new iframe can be loaded after Start quiz was already clicked.
      if ((this.progress.navigationStage || this.progress.phase) === 'starting' &&
          this.progress.targetTopic && !this.findSelector()) {
        return this.finish(token);
      }
      let selector = this.findSelector();
      if (!selector) {
        const back = await this.waitFor(() => this.findButton(/^返回上一页$/), '未找到“返回上一页”按钮。', token);
        this.check(token);
        F.click(back);
        selector = await this.waitFor(() => this.findSelector(), '返回后没有出现知识点下拉框。', token);
      }
      await this.commit({ phase: 'selecting', navigationStage: 'selecting', resume: true }, token);
      if (selector.tagName !== 'SELECT' && selector.getAttribute('aria-expanded') !== 'true') this.key(selector, 'ArrowDown');
      const options = await this.waitFor(() => {
        const available = this.options(selector);
        return available.length ? available : null;
      }, '知识点下拉框为空（暂无数据），请检查 Coze 登录和平台额度后点“开始”重试。', token);
      const next = this.progress.targetTopic ? options.find(option => !option.disabled &&
        normalizeTopic(option.text) === normalizeTopic(this.progress.targetTopic)) :
        nextTopic(options, this.progress.currentTopic, this.progress.completed);
      if (!next) {
        if (this.progress.targetTopic) throw new Error('之前选择的知识点已不可用，请重置后重新选择。');
        if (selector.tagName !== 'SELECT') this.key(document.activeElement || selector, 'Escape');
        await this.commit({ phase: 'complete', navigationStage: '', resume: false, needsNavigation: false, targetTopic: '' }, token);
        this.engine.setState('chapters_complete');
        return;
      }
      await this.commit({ targetTopic: next.text }, token);
      this.check(token);
      if (selector.tagName === 'SELECT') {
        selector.value = next.el.value;
        selector.dispatchEvent(new Event('input', { bubbles: true }));
        selector.dispatchEvent(new Event('change', { bubbles: true }));
      } else this.key(next.el, 'Enter');
      await this.waitFor(() => {
        const current = this.findSelector();
        const text = current?.tagName === 'SELECT' ? current.selectedOptions[0]?.textContent : U.textOf(current);
        return normalizeTopic(text) === normalizeTopic(next.text);
      }, '知识点选择没有生效，已停止。', token, Math.min(5000, this.navigationTimeoutMs));
      const start = await this.waitFor(() => this.findButton(/^开始答题$/),
        '选择知识点后未找到可用的“开始答题”按钮。', token);
      await this.commit({ phase: 'starting', navigationStage: 'starting', resume: true }, token);
      this.check(token);
      F.click(start);
      await this.finish(token);
    }

    async finish(token) {
      const topic = this.progress.targetTopic;
      await this.waitFor(() => {
        const messages = this.engine.readMessages();
        const last = this.engine.pickTargetMessage(messages);
        const blocked = last && platformError(last.text);
        if (blocked) throw new Error(blocked);
        if (!this.engine.resolveInput() || !last) return false;
        // The selected topic was already read back before Start quiz. A fresh
        // SDK conversation now needs the normal, confirmed "是" handshake first.
        if (C.classify.isStartPrompt(last.text)) return true;
        return C.classify.looksLikeQuestion(last.text) && !C.classify.isFeedback(last.text) &&
          normalizeTopic(topicOf(last.text)) === normalizeTopic(topic);
      }, '新知识点尚未出现题目，请检查 Coze 平台状态后重试。', token);
      const rounds = Math.max(this.engine.rounds, this.progress.rounds || 0);
      await this.commit({
        phase: 'answering', navigationStage: '', currentTopic: topic, targetTopic: '', needsNavigation: false,
        resume: false, rounds, error: ''
      }, token);
      this.check(token);
      this.engine.reset();
      this.engine.rounds = rounds;
      this.engine.start();
    }
  }

  C.chapters = { parseFeedback, topicOf, normalizeTopic, nextTopic, platformError, initialProgress };
  C.ChapterFlow = ChapterFlow;
})();
