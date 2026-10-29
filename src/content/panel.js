/* 浮动面板：Shadow DOM 隔离样式，避免被 Coze 的 Tailwind / Semi 影响 */
(function () {
  const CAH = (globalThis.__CAH__ = globalThis.__CAH__ || {});

  const CSS = `
    :host { all: initial; }
    .wrap {
      position: fixed; z-index: 2147483646; right: 18px; bottom: 18px;
      width: 340px; max-height: min(560px, calc(100vh - 96px));
      font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #1f2328; background: #fff; border: 1px solid #d0d7de; border-radius: 10px;
      box-shadow: 0 8px 28px rgba(0,0,0,.18); display: flex; flex-direction: column; overflow: hidden;
    }
    .wrap.collapsed { width: 148px; }
    .wrap.collapsed .body { display: none; }
    header {
      display: flex; align-items: center; gap: 8px; padding: 9px 10px;
      background: #f6f8fa; border-bottom: 1px solid #e5e8eb; cursor: default; user-select: none;
    }
    header .title { font-weight: 600; flex: 1; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9aa4af; flex: none; }
    .dot.running { background: #2da44e; }
    .dot.generating, .dot.sending, .dot.checking_score, .dot.switching_chapter { background: #bf8700; }
    .dot.chapters_complete { background: #2da44e; }
    .dot.error { background: #cf222e; }
    .dot.ready, .dot.advance_ready { background: #0969da; }
    button {
      font: inherit; cursor: pointer; border-radius: 6px; border: 1px solid #d0d7de;
      background: #f6f8fa; padding: 4px 10px; color: #1f2328;
    }
    button:hover { background: #eef1f4; }
    button.primary { background: #1f883d; border-color: #1a7f37; color: #fff; }
    button.primary:hover { background: #1a7f37; }
    button.ghost { background: transparent; border-color: transparent; padding: 2px 6px; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .body { padding: 10px; display: flex; flex-direction: column; gap: 9px; overflow: auto; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .label { color: #57606a; font-size: 12px; }
    .q, .a {
      background: #f6f8fa; border: 1px solid #e5e8eb; border-radius: 6px; padding: 7px 8px;
      white-space: pre-wrap; word-break: break-word; overflow: auto; font-size: 12px;
      flex: 0 1 auto; min-height: 34px;
    }
    .q { max-height: 96px; }
    .a { max-height: 72px; }
    .q:empty::before { content: "（等待识别到题目）"; color: #8c959f; }
    .a:empty::before { content: "（还没有答案）"; color: #8c959f; }
    .a.answer { color: #0a3069; }
    .explain { color: #57606a; font-size: 11.5px; white-space: pre-wrap; }
    .err { color: #cf222e; font-size: 12px; white-space: pre-wrap; }
    .chapter { color: #57606a; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .chapter:empty { display: none; }
    .diag {
      background: #fbfcfd; border: 1px solid #d0d7de; border-radius: 6px; padding: 8px;
      font: 11px/1.55 ui-monospace, Consolas, monospace; white-space: pre-wrap;
      max-height: 240px; overflow: auto; color: #24292f;
    }
    .diag:empty { display: none; }
    .meta { display: flex; justify-content: space-between; color: #8c959f; font-size: 11px; }
    .toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #57606a; }
    .toggle input { margin: 0; }
    .spacer { flex: 1; }
  `;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') el.className = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v);
      }
    }
    for (const k of kids.flat()) {
      if (k == null) continue;
      el.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
    return el;
  }

  class Panel {
    constructor({ onStart, onStop, onReset, onGenerate, onSend, onSkip, onBind, onDebug, onOpenOptions, onToggle, onDiagnose, getSettings }) {
      this.handlers = { onStart, onStop, onReset, onGenerate, onSend, onSkip, onBind, onDebug, onOpenOptions, onToggle, onDiagnose, getSettings };
      this.mount();
    }

    mount() {
      this.host = document.createElement('div');
      this.host.id = 'cah-panel-host';
      this.host.style.cssText = 'all: initial; position: fixed; z-index: 2147483646;';
      this.root = this.host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;
      this.root.append(style);
      this.wrap = h('div', { class: 'wrap' });
      this.build();
      this.root.append(this.wrap);
      document.documentElement.append(this.host);
      this.expanded = true;
    }

    build() {
      const H = this.handlers;
      this.dot = h('span', { class: 'dot idle' });
      this.titleText = h('span', { class: 'title' }, 'Coze 答题助手');
      this.btnCollapse = h('button', { class: 'ghost', title: '收起/展开', onclick: () => this.toggleCollapse() }, '−');
      this.header = h(
        'header',
        {},
        this.dot,
        this.titleText,
        this.btnCollapse
      );

      this.qEl = h('div', { class: 'q' });
      this.aEl = h('div', { class: 'a' });
      this.explainEl = h('div', { class: 'explain' });
      this.errEl = h('div', { class: 'err' });
      this.metaEl = h('div', { class: 'meta' });
      this.chapterEl = h('div', { class: 'chapter', 'aria-live': 'polite' });

      this.btnStart = h('button', { class: 'primary', onclick: () => this.onStartClick() }, '开始');
      this.btnStop = h('button', { onclick: () => H.onStop && H.onStop() }, '暂停');
      this.btnReset = h('button', { onclick: () => H.onReset && H.onReset() }, '重置');
      this.btnGen = h('button', { onclick: () => H.onGenerate && H.onGenerate() }, '生成');
      this.btnSend = h('button', { class: 'primary', onclick: () => H.onSend && H.onSend() }, '发送');
      this.btnSkip = h('button', { onclick: () => H.onSkip && H.onSkip() }, '跳过');

      this.chkAutoAdvance = h('input', {
        type: 'checkbox',
        onchange: () => this.onToggleChange('autoAdvance', this.chkAutoAdvance.checked)
      });
      this.chkRequireConfirm = h('input', {
        type: 'checkbox',
        onchange: () => this.onToggleChange('requireConfirm', this.chkRequireConfirm.checked)
      });
      this.chkAutoSwitchChapter = h('input', {
        type: 'checkbox',
        onchange: () => this.onToggleChange('autoSwitchChapter', this.chkAutoSwitchChapter.checked)
      });

      const autoRow = h(
        'div',
        { class: 'row' },
        h('label', { class: 'toggle' }, this.chkRequireConfirm, '发送前确认'),
        h('label', { class: 'toggle' }, this.chkAutoAdvance, '自动回「是」'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', onclick: () => H.onOpenOptions && H.onOpenOptions() }, '设置')
      );

      const bindRow = h(
        'div',
        { class: 'row' },
        h('span', { class: 'label' }, '绑定：'),
        h('button', { class: 'ghost', onclick: () => this.bind('input') }, '输入框'),
        h('button', { class: 'ghost', onclick: () => this.bind('messageList') }, '消息列表'),
        h('button', { class: 'ghost', onclick: () => this.bind('sendButton') }, '发送按钮'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost', onclick: () => this.diagnose() }, '诊断'),
        h('button', { class: 'ghost', onclick: () => H.onDebug && H.onDebug() }, '导出')
      );

      this.diagEl = h('div', { class: 'diag' });

      const body = h(
        'div',
        { class: 'body' },
        h('div', { class: 'label' }, '题目'),
        this.qEl,
        h('div', { class: 'label' }, '答案'),
        this.aEl,
        this.explainEl,
        this.errEl,
        h('div', { class: 'row' }, this.btnStart, this.btnStop, this.btnReset),
        h('div', { class: 'row' }, this.btnGen, this.btnSend, this.btnSkip, h('span', { class: 'spacer' }), this.metaEl),
        autoRow,
        h('label', { class: 'toggle' }, this.chkAutoSwitchChapter, '答对不加分时切换知识点'),
        this.chapterEl,
        bindRow,
        this.diagEl
      );

      this.body = body;
      this.wrap.append(this.header, body);
    }

    toggleCollapse() {
      this.expanded = !this.expanded;
      this.wrap.classList.toggle('collapsed', !this.expanded);
      this.btnCollapse.textContent = this.expanded ? '−' : '+';
    }

    setPicking(active) {
      if (active) this.host.style.setProperty('visibility', 'hidden', 'important');
      else this.host.style.removeProperty('visibility');
    }

    onStartClick() {
      this.handlers.onStart && this.handlers.onStart();
    }

    onToggleChange(key, value) {
      const s = this.handlers.getSettings ? this.handlers.getSettings() : {};
      s[key] = value;
      this.handlers.onToggle && this.handlers.onToggle(key, value);
    }

    bind(kind) {
      this.handlers.onBind && this.handlers.onBind(kind);
    }

    /** 点击「诊断」：优先向选中的 frame 要数据（顶层往往是空壳） */
    diagnose() {
      if (typeof this.handlers.onDiagnose === 'function') {
        this.handlers.onDiagnose();
        return;
      }
      this.renderDiagnose(CAH.detect && CAH.detect.diagnose ? CAH.detect.diagnose() : null);
    }

    renderDiagnose(info) {
      if (!info) {
        this.diagEl.textContent = '诊断不可用';
        return;
      }
      const lines = [];
      lines.push('构建: ' + (info.build || 'unknown'));
      if (info.frameNote) lines.push(info.frameNote);
      for (const s of info.steps) {
        if (s.step === '登录表单') {
          lines.push('【登录表单】' + s.result + '  提交按钮: ' + s.submit);
          if (s.form) lines.push('  学号框=' + s.form.id + ' 姓名框=' + s.form.name);
          for (const i of s.inputs || []) {
            lines.push('  <' + i.tag + ' type=' + i.type + '> ph="' + i.placeholder + '" id="' + i.id + '" name="' + i.name + '" 标签="' + i.label.replace(/\n/g, ' ') + '"');
          }
        } else if (s.step === '滚动容器' || s.step === '消息列表') {
          lines.push('【' + s.step + '】结果: ' + s.result);
          const key = s.step === '消息列表' ? 'rows' : 'threshold';
          if (s[key] !== undefined) lines.push('  ' + key + ': ' + s[key]);
          const top = s.top || [];
          for (const c of top) {
            lines.push('  ' + (c.score !== undefined ? String(c.score).padStart(3) : '   ') + '  ' + c.path.slice(0, 100));
          }
        } else if (s.step === '消息行') {
          lines.push('【消息行】共 ' + s.total + ' 条');
          for (const t of s.last5) lines.push('  · ' + t.replace(/\n/g, ' ⏎ '));
        } else if (s.step === '输入框') {
          lines.push('【输入框】' + s.result);
          for (const c of s.candidates || []) lines.push('  ' + c.tag + '  ' + c.path.slice(0, 80));
        } else if (s.step === '分类') {
          lines.push('【分类】题目=' + s.isQuestion + ' 开场=' + !!s.isStart + ' 继续=' + s.isContinue + ' 反馈=' + s.isFeedback);
          lines.push('  末条: ' + s.lastText.replace(/\n/g, ' ⏎ '));
        } else {
          lines.push('【' + s.step + '】' + (s.result || ''));
        }
      }
      this.diagEl.textContent = lines.join('\n');
    }

    update(snap) {
      const names = { idle: '未启动', running: '监听中', generating: '生成中', ready: '待发送',
        sending: '发送中', waiting: '等待回复', advance_ready: '等待继续', error: '出错',
        checking_score: '等待分值', switching_chapter: '切换知识点', chapters_complete: '知识点已完成' };
      const build = CAH.BUILD ? ' · ' + (CAH.BUILD.match(/#\d+/) || [CAH.BUILD])[0] : '';
      this.titleText.textContent = 'Coze 答题助手 · ' + (names[snap.state] || snap.state) + build;
      this.dot.className = 'dot ' + snap.state;
      this.setBlock(this.qEl, snap.question);
      this.setBlock(this.aEl, snap.answer);
      this.aEl.classList.toggle('answer', !!snap.answer);
      this.explainEl.textContent = snap.explanation || '';
      this.errEl.textContent = snap.error || '';
      this.metaEl.textContent = snap.rounds ? snap.rounds + ' 轮' : '';
      const chapter = snap.chapter;
      const phases = { checking_score: '等待分值', returning: '返回知识点页', selecting: '选择知识点',
        starting: '等待新题', answering: '答题中', complete: '可用知识点已完成', paused: '已暂停', error: '切换已停止' };
      this.chapterEl.textContent = chapter && (chapter.currentTopic || chapter.targetTopic || chapter.completed.length) ?
        '知识点：' + (chapter.targetTopic || chapter.currentTopic) + '\n已完成 ' + chapter.completed.length +
        ' 个' + (phases[chapter.phase] ? ' · ' + phases[chapter.phase] : '') : '';
      if (this.chkAutoAdvance.checked !== !!snap.autoAdvance) this.chkAutoAdvance.checked = !!snap.autoAdvance;
      if (this.chkRequireConfirm.checked !== !!snap.requireConfirm) this.chkRequireConfirm.checked = !!snap.requireConfirm;
      this.chkAutoSwitchChapter.checked = snap.autoSwitchChapter !== false;
      this.btnStart.disabled = !['idle', 'error'].includes(snap.state);
      this.btnSend.disabled = !snap.answer || !['ready', 'advance_ready', 'error'].includes(snap.state);
      const navigating = ['switching_chapter', 'checking_score', 'chapters_complete'].includes(snap.state);
      this.btnGen.disabled = navigating || !snap.question || ['generating', 'sending'].includes(snap.state);
      this.btnSkip.disabled = navigating;
    }

    setBlock(el, text) {
      if (el.dataset.last === (text || '')) return;
      el.dataset.last = text || '';
      el.textContent = text || '';
    }

    toast(msg) {
      const t = h('div', {
        class: 'toast', role: 'status',
        style:
          'position:fixed;right:18px;bottom:24px;max-width:320px;overflow-wrap:anywhere;background:#1f2328;color:#fff;padding:8px 12px;border-radius:6px;font:12px/1.5 sans-serif;z-index:2147483647'
      }, msg);
      this.root.append(t);
      setTimeout(() => t.remove(), 2200);
    }
  }

  CAH.Panel = Panel;
})();
