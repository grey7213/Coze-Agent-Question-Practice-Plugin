/* 内容脚本装配：存储、面板、引擎、手动绑定、调试导出 */
(function () {
  const CAH = (globalThis.__CAH__ = globalThis.__CAH__ || {});
  const U = CAH.util;
  const D = CAH.detect;

  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.runtime;
  let settings = CAH.defaults.withDefaults({});

  let panel = null;
  let engine = null;
  let chapterFlow = null;
  let settingsReady = false;
  let chapterRestore = null;
  let commandEpoch = 0;
  let bindingFrameId = null;
  /** 子 frame 最近一次上报的快照，顶层用它渲染面板 */
  let pendingSnap = null;
  let pendingDiag = null;
  const emitRef = {};

  function currentSnapshot() {
    const isTop = window.top === window;
    // 顶层：优先用子 frame 上报的状态（顶层自己通常是空壳）
    // 子 frame：用本地引擎的状态
    if (isTop && pendingSnap) return pendingSnap;
    if (isTop && activeFrameId) return pendingSnap || { state: 'running' };
    return (engine && engine.snapshot()) || {};
  }

  function emit(event, data) {
    if (event === 'state' || event === 'answer' || event === 'question') scheduleUpdate();
    if (panel && panel.update) panel.update(currentSnapshot());
    // 子 frame：把状态同步给顶层
    if (emitRef.report) emitRef.report(currentSnapshot());
  }

  function scheduleUpdate() {
    if (scheduleUpdate.q) return;
    scheduleUpdate.q = true;
    requestAnimationFrame(() => {
      scheduleUpdate.q = false;
      if (panel && panel.update) panel.update(currentSnapshot());
    });
  }

  async function askAI(payload) {
    if (!hasChrome) return { ok: false, error: '当前环境没有扩展运行时，无法调用模型' };
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ask',
        question: payload.question,
        history: payload.history,
        systemPrompt: payload.systemPrompt
      });
      return res || { ok: false, error: '后台没有返回结果' };
    } catch (e) {
      return { ok: false, error: '调用后台失败：' + e.message + '（扩展可能被重新加载，刷新页面即可）' };
    }
  }

  async function persist() {
    if (!hasChrome) return;
    const result = await chrome.runtime.sendMessage({ type: 'update-content-settings', settings });
    if (!result || !result.ok) throw new Error('保存设置失败');
  }

  // ---------- 跨 frame 协调 ----------

  let bus = null;
  /** 顶层选中的目标 frame（真正有内容的那个） */
  let activeFrameId = null;
  /** 已知的子 frame：frameId -> {hasContent, hasLogin, taCount, ...} */
  const knownFrames = new Map();

  function selectActiveFrame() {
    const now = Date.now();
    for (const [id, caps] of knownFrames) if (now - caps.lastSeen > 6500) knownFrames.delete(id);
    const frames = [...knownFrames.values()];
    frames.sort((a, b) =>
      Number(b.taCount > 0) - Number(a.taCount > 0) ||
      Number(b.hasContent) - Number(a.hasContent) ||
      b.listRows - a.listRows || b.lastSeen - a.lastSeen
    );
    const next = frames[0]?.frameId || null;
    if (next === activeFrameId) return;
    activeFrameId = next;
    pendingSnap = null;
    if (bus) bus.selectFrameId = next;
    onActiveFrameChanged();
    scheduleUpdate();
  }

  function setupBus(isTop) {
    bus = new CAH.Bus({
      isTop,
      onCommand: (action, payload) => handleCommand(action, payload),
      onHello: (frameId, caps) => {
        if (!isTop) return;
        knownFrames.set(frameId, Object.assign({}, caps, { frameId, lastSeen: Date.now() }));
        selectActiveFrame();
      },
      onBye: (frameId) => { knownFrames.delete(frameId); selectActiveFrame(); },
      onToast: (frameId, message) => {
        if (isTop && frameId === activeFrameId) panel.toast(message);
      },
      onPick: (frameId, active) => {
        if (!isTop || (frameId !== activeFrameId && frameId !== bindingFrameId)) return;
        bindingFrameId = active ? frameId : null;
        panel.setPicking(active);
      },
      onStatus: (from, snap) => {
        if (!isTop) return;
        if (from === activeFrameId && snap) {
          pendingSnap = snap;
          scheduleUpdate();
        }
      },
      onDiag: (frameId, info) => {
        if (!isTop) return;
        if (info) {
          info.frameNote = '来源: 子 frame ' + frameId + (frameId === activeFrameId ? '（当前目标）' : '（非当前目标）');
        }
        panel && panel.renderDiagnose(info);
      }
    });

    if (!isTop) {
      // 子 frame：周期性宣告自己，避免顶层晚于自己启动时漏掉握手
      const announce = () => {
        if (!bus) return;
        const caps = probeContent();
        bus.hello(caps);
        bus.report(engine.snapshot());
      };
      announce();
      setTimeout(announce, 800);
      setTimeout(announce, 2000);
      setTimeout(announce, 4000);
      let heartbeat = setInterval(announce, 2000);
      window.addEventListener('pagehide', () => {
        clearInterval(heartbeat);
        heartbeat = null;
        bus.bye();
      });
      window.addEventListener('pageshow', () => {
        if (!heartbeat) heartbeat = setInterval(announce, 2000);
        announce();
      });

      // 子 frame 的引擎状态变化同步给顶层
      emitRef.report = (snap) => {
        if (bus) bus.report(snap);
      };
      return;
    }
    setInterval(selectActiveFrame, 2000);
  }

  /** 顶层：诊断要问真正有内容的那个 frame */
  function requestDiagnose() {
    if (!activeFrameId || !bus) {
      // 还没握手完成：告诉用户等一下，而不是给出误导性的顶层结果
      if (bus && knownFrames.size === 0) {
        panel.renderDiagnose({
          build: CAH.BUILD,
          frameNote: '等待子 frame 握手…（若一直停留在此，说明 Coze 页面结构变了，或扩展未刷新）',
          steps: []
        });
        // 再等一会儿
        setTimeout(() => {
          if (activeFrameId) requestDiagnose();
        }, 1200);
        return;
      }
      const info = CAH.detect.diagnose ? CAH.detect.diagnose() : null;
      if (info) info.frameNote = '来源: 顶层文档（本页没有子 frame）';
      panel.renderDiagnose(info);
      return;
    }
    panel.diagEl.textContent = '正在向目标 frame 取诊断…';
    bus.send('diagnose', {}, activeFrameId);
    // 子 frame 会通过 status 之外的专用消息回传，这里起一个短超时兜底
    setTimeout(() => {
      if (panel.diagEl.textContent.startsWith('正在')) {
        panel.renderDiagnose({
          build: CAH.BUILD,
          frameNote: '未收到子 frame 响应（frameId=' + activeFrameId + '）。可能 frame 已重载。',
          steps: []
        });
      }
    }, 2500);
  }

  /** 顶层：选中的 frame 变了，刷新一次面板并从它那儿取状态 */
  function onActiveFrameChanged() {
    if (bindingFrameId && bindingFrameId !== activeFrameId) {
      if (bus) bus.send('cancel-bind', {}, bindingFrameId);
      bindingFrameId = null;
      if (panel.setPicking) panel.setPicking(false);
    }
    if (!bus || !activeFrameId) return;
    bus.send('snapshot', {}, activeFrameId);
  }

  /** 探测本 frame 有多少可操作内容 */
  function probeContent() {
    let taCount = 0;
    let loginLooks = false;
    let listRows = 0;
    try {
      taCount = document.querySelectorAll('textarea, input, [contenteditable="true"]').length;
      loginLooks = !!(CAH.login && CAH.login.looksLikeLoginPage());
      const list = CAH.detect.findMessageList();
      listRows = CAH.detect.getMessageRows(list).length;
    } catch (e) {
      /* ignore */
    }
    const hasKnowledge = !!(chapterFlow && chapterFlow.findSelector());
    return { taCount, loginLooks, listRows, hasKnowledge,
      hasContent: taCount > 0 || listRows >= 2 || loginLooks || hasKnowledge };
  }

  async function handleCommand(action, payload = {}) {
    if (!engine) return;
    if (['generate', 'send', 'skip'].includes(action) && chapterFlow.enabled() && chapterFlow.progress.needsNavigation) return;
    switch (action) {
      case 'start': {
        const token = ++commandEpoch;
        await restoreChapters();
        if (token !== commandEpoch) return;
        if (!chapterFlow.start()) engine.start();
        break;
      }
      case 'stop':
        ++commandEpoch;
        stopPick();
        chapterFlow.pause();
        engine.stop();
        break;
      case 'reset':
        ++commandEpoch;
        stopPick();
        chapterFlow.reset();
        engine.reset();
        break;
      case 'generate':
        engine.regenerate();
        break;
      case 'send':
        engine.sendCurrent();
        break;
      case 'skip':
        engine.skip();
        break;
      case 'settings':
        if (payload.key && Object.hasOwn(settings, payload.key)) settings[payload.key] = payload.value;
        engine.setSettings(settings);
        stopDisabledChapterFlow();
        break;
      case 'bind':
        ++commandEpoch;
        chapterFlow.pause();
        engine.stop();
        startPick(payload.kind);
        break;
      case 'cancel-bind':
        stopPick();
        break;
      case 'snapshot':
        // 顶层索要当前状态
        break;
      case 'diagnose': {
        const info = CAH.detect.diagnose ? CAH.detect.diagnose() : null;
        if (bus) bus.emit({ type: 'diag', payload: info });
        return;
      }
      default:
        break;
    }
    // 命令执行后回报状态
    if (bus) bus.report(engine.snapshot());
  }

  /** 顶层：把操作转给 activeFrame，或在没有子 frame 时自己执行 */
  function dispatch(action, payload) {
    if (activeFrameId && bus) {
      bus.send(action, payload, activeFrameId);
      return;
    }
    // 没有子 frame（或子 frame 未就绪）时，顶层自己干
    handleCommand(action, payload);
  }

  function initPanel() {
    panel = new CAH.Panel({
      getSettings: () => settings,
      onStart: () => {
        dispatch('start');
        if (!panel.expanded) panel.toggleCollapse();
      },
      onStop: () => dispatch('stop'),
      onReset: () => dispatch('reset'),
      onGenerate: () => dispatch('generate'),
      onSend: () => dispatch('send'),
      onSkip: () => dispatch('skip'),
      onToggle: (key, value) => {
        settings[key] = value;
        engine.setSettings(settings);
        stopDisabledChapterFlow();
        persist().catch(error => panel.toast(error.message));
        if (bus) bus.send('settings', { key, value }, activeFrameId);
        panel.update(currentSnapshot());
      },
      onBind: (kind) => {
        if (activeFrameId) {
          bindingFrameId = activeFrameId;
          panel.setPicking(true);
        }
        dispatch('bind', { kind });
      },
      onDiagnose: () => requestDiagnose(),
      onDebug: () => exportDebug(),
      onOpenOptions: () => {
        if (hasChrome) chrome.runtime.sendMessage({ type: 'open-options' });
      }
    });
    panel.update(engine.snapshot());
  }

  // ---------- 手动绑定：点一个元素，存 CSS 路径 ----------

  let picking = null;

  function startPick(kind) {
    if (!['input', 'messageList', 'sendButton'].includes(kind)) return;
    if (picking) stopPick();
    picking = { kind };
    if (window.top === window) panel.setPicking(true);
    else if (bus) bus.emit({ type: 'pick', active: true });
    const mask = document.createElement('div');
    mask.id = 'cah-pick-mask';
    mask.style.cssText =
      'position:fixed;inset:0;z-index:2147483645;cursor:crosshair;background:rgba(9,105,218,.08)';
    const tip = document.createElement('div');
    tip.textContent = '点击要绑定的元素（Esc 取消）';
    tip.style.cssText =
      'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#1f2328;color:#fff;padding:8px 14px;border-radius:8px;font:13px/1.5 -apple-system,"Microsoft YaHei",sans-serif;pointer-events:none';
    picking.mask = mask;
    picking.tip = tip;

    const elementAt = (e) => {
      mask.style.pointerEvents = 'none';
      let el = document.elementFromPoint(e.clientX, e.clientY);
      mask.style.pointerEvents = '';
      if (!el || el === mask || el === tip) return null;
      if (kind === 'input') el = el.closest('textarea,input,[contenteditable="true"],[role="textbox"]') || el;
      if (kind === 'sendButton') el = el.closest('button,[role="button"]') || el;
      return el;
    };
    const clearHover = () => {
      if (!picking || !picking.hover) return;
      const el = picking.hover;
      if (picking.outline) el.style.setProperty('outline', picking.outline, picking.outlinePriority);
      else el.style.removeProperty('outline');
      picking.hover = null;
    };
    picking.clearHover = clearHover;
    const onMove = (e) => {
      const el = elementAt(e);
      if (!picking || el === picking.hover) return;
      clearHover();
      if (!el) return;
      picking.hover = el;
      picking.outline = el.style.getPropertyValue('outline');
      picking.outlinePriority = el.style.getPropertyPriority('outline');
      el.style.setProperty('outline', '2px solid #0969da', 'important');
    };
    const onClick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const el = elementAt(e);
      if (!el) return stopPick();
      const path = U.cssPath(el);
      const selectedKind = picking.kind;
      settings.overrides[selectedKind] = path;
      engine.setSettings(settings);
      stopPick();
      try {
        await persist();
        panel.toast('已绑定 ' + selectedKind + '：' + path.slice(0, 60));
      } catch (error) { panel.toast(error.message); }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') stopPick();
    };

    mask.addEventListener('mousemove', onMove, true);
    mask.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    document.documentElement.append(mask, tip);
    window.focus();
    picking.off = () => {
      mask.removeEventListener('mousemove', onMove, true);
      mask.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }

  function stopPick() {
    if (!picking) return;
    picking.off && picking.off();
    if (picking.clearHover) picking.clearHover();
    picking.mask && picking.mask.remove();
    picking.tip && picking.tip.remove();
    picking = null;
    if (window.top === window) panel.setPicking(false);
    else if (bus) bus.emit({ type: 'pick', active: false });
  }

  // ---------- 调试导出 ----------

  function exportDebug() {
    const data = D.dumpDebug();
    data.settings = Object.assign({}, settings, { apiKey: '', loginStudentId: '', loginName: '' });
    let json = JSON.stringify(data, null, 2);
    for (const value of [settings.apiKey, settings.loginStudentId, settings.loginName].filter(Boolean)) {
      json = json.split(value).join('[已隐藏]');
    }
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'coze-answer-helper-debug-' + Date.now() + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
    panel && panel.toast('调试信息已导出（密钥和身份信息已隐藏）');
  }

  // ---------- 启动 ----------

  function applySettings(saved) {
    const safe = Object.assign({}, saved);
    delete safe.apiKey;
    settings = CAH.defaults.withDefaults(safe);
    engine.setSettings(settings);
    stopDisabledChapterFlow();
    if (panel.update) panel.update(currentSnapshot());
  }

  function stopDisabledChapterFlow() {
    if (chapterFlow && !chapterFlow.enabled() && (chapterFlow.busy || chapterFlow.progress.resume)) {
      chapterFlow.pause();
      engine.stop();
    }
  }

  function ownsCoursePage() {
    // The store shell shares the app ID but must never resume iframe navigation.
    if (/\/store\/project\//.test(location.pathname)) return false;
    if (/\/ui-builder-app\/\d+/.test(location.pathname)) return true;
    if (window.top === window && document.querySelector('iframe')) return false;
    return !!(engine.resolveInput() || chapterFlow.findSelector());
  }

  function restoreChapters() {
    if (!settingsReady || !ownsCoursePage()) return Promise.resolve();
    if (!chapterRestore) {
      chapterRestore = chapterFlow.restore().catch(() => engine.fail('读取章节进度失败，请刷新页面后重试'));
    }
    return chapterRestore;
  }

  function boot() {
    // Coze 把智能体页面放在 iframe 里（ui-builder-app），所以内容脚本用
    // all_frames:true 注入每一层。面板只在顶层画出，命令通过 Bus 下发到
    // 真正有内容的子 frame —— 顶层往往是个空壳，什么都识别不到。
    const isTop = window.top === window;

    engine = new CAH.Engine({ settings, askAI, emit,
      inspectMessages: messages => chapterFlow && chapterFlow.inspectMessages(messages) });
    const progressRequest = async (action, progress) => {
      if (!hasChrome) return null;
      const result = await chrome.runtime.sendMessage({ type: 'chapter-progress', action, progress });
      if (!result || !result.ok) throw new Error('章节进度读写失败');
      return result.progress || null;
    };
    chapterFlow = new CAH.ChapterFlow({
      engine, load: () => progressRequest('load'), save: progress => progressRequest('save', progress),
      onChange: () => emit('state')
    });

    if (isTop) {
      initPanel();
    } else {
      panel = {
        update: () => {},
        toast: (msg) => {
          if (bus) bus.emit({ type: 'toast', text: msg });
        }
      };
    }

    setupBus(isTop);
    window.addEventListener('pagehide', () => {
      ++commandEpoch;
      stopPick();
      chapterFlow.abandon();
      engine.stop();
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && isTop && bindingFrameId) {
        bus.send('cancel-bind', {}, bindingFrameId);
      }
    }, true);

    if (!hasChrome) {
      engine.setState('idle');
      return;
    }

    chrome.runtime.sendMessage({ type: 'init-settings' }, (got) => {
      if (chrome.runtime.lastError || !got || !got.ok) {
        engine.fail('读取扩展设置失败，请刷新页面后重试');
        return;
      }
      applySettings(got.settings);
      settingsReady = true;
      restoreChapters();
      const courseObserver = new MutationObserver(() => {
        if (chapterRestore) { courseObserver.disconnect(); return; }
        restoreChapters();
      });
      if (!chapterRestore) courseObserver.observe(document.documentElement, { childList: true, subtree: true });
      // 设置是异步读回来的，登录检查必须等它到齐
      scheduleLoginCheck();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.settings) {
        applySettings(changes.settings.newValue);
      }
    });

    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !msg.type) return;
      if (msg.type === 'panel-toggle' && isTop) {
        panel.toggleCollapse();
      }
    });
  }

  // ---------- 自动登录 ----------

  let loginTried = false;

  function scheduleLoginCheck() {
    if (!settings.autoLogin) return;
    // 单页应用的路由切换不会重新注入脚本，所以既要首轮检查，也要监听 DOM 变化
    const run = async () => {
      if (loginTried) return;
      if (!CAH.login || !CAH.login.looksLikeLoginPage()) return;
      loginTried = true;
      const res = await CAH.login.attemptLogin(settings, { dryRun: !settings.loginAutoSubmit });
      if (res.skipped) {
        loginTried = false;
        return;
      }
      if (res.ok) {
        panel && panel.toast(
          settings.loginAutoSubmit ? '已填写并提交登录' : '已填写学号/姓名，请手动点登录'
        );
        if (!settings.loginAutoSubmit) loginTried = false;
      } else {
        loginTried = false;
        panel && panel.toast('自动登录失败：' + res.reason);
      }
    };

    setTimeout(run, 800);
    const obs = new MutationObserver(() => {
      if (!loginTried) run();
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    // 十分钟后停止观察，避免常驻开销
    setTimeout(() => obs.disconnect(), 10 * 60 * 1000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  CAH.__test__ = {
    get engine() { return engine; },
    get chapters() { return chapterFlow; },
    get panel() { return panel; },
    get settings() { return settings; },
    get activeFrameId() { return activeFrameId; },
    get knownFrames() { return [...knownFrames.values()]; }
  };
  // 供测试脚本读取内部状态
  if (window.top === window) {
    window.__cahBusDebug = () => ({
      activeFrameId,
      known: [...knownFrames.values()],
      hasPending: !!pendingSnap,
      state: pendingSnap && pendingSnap.state
    });
  }
})();
