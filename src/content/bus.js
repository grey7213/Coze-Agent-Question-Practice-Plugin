/* 跨 frame 协调：扩展通过后台在当前 tab 内中转；普通网页测试使用 BroadcastChannel。 */
(function () {
  const CAH = (globalThis.__CAH__ = globalThis.__CAH__ || {});

  const CHANNEL = 'cah-frame-bus';

  /**
   * 每个 frame 都建一个总线。
   * - 子 frame 收到顶层命令后执行，并回报状态
   * - 顶层收到子 frame 的状态后刷新面板
   */
  class Bus {
    constructor(opts) {
      this.isTop = !!opts.isTop;
      this.onCommand = opts.onCommand || (() => {});
      this.onStatus = opts.onStatus || (() => {});
      this.onHello = opts.onHello || (() => {});
      this.onDiag = opts.onDiag || (() => {});
      this.onBye = opts.onBye || (() => {});
      this.onToast = opts.onToast || (() => {});
      this.onPick = opts.onPick || (() => {});
      this.frameId = Math.random().toString(36).slice(2, 8);
      this.lastStatus = null;
      this.listeners = new Set();

      this.useRuntime = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
      if (this.useRuntime) {
        this.runtimeListener = (msg) => {
          if (msg?.type === 'frame-bus') this.handle(msg.message);
        };
        chrome.runtime.onMessage.addListener(this.runtimeListener);
        this.ch = null;
        return;
      }
      try {
        this.ch = new BroadcastChannel(CHANNEL);
        this.ch.onmessage = (ev) => this.handle(ev.data);
      } catch (e) {
        // BroadcastChannel 不可用时退化为单 frame 模式
        this.ch = null;
      }
    }

    handle(msg) {
      if (!msg || !msg.type) return;
      // 自己发的消息忽略
      if (msg.from === this.frameId) return;

      if (msg.type === 'cmd' && !this.isTop) {
        // 顶层下发的命令，只发给被选中的 frame
        if (msg.target && msg.target !== this.frameId) return;
        this.onCommand(msg.action, msg.payload);
        return;
      }
      if (msg.type === 'status' && this.isTop) {
        // 子 frame 上报状态
        if (this.selectFrameId && msg.from !== this.selectFrameId) return;
        this.lastStatus = msg.payload;
        this.onStatus(msg.from, msg.payload);
        return;
      }
      if (msg.type === 'diag' && this.isTop) {
        // 子 frame 回传诊断
        this.onDiag && this.onDiag(msg.from, msg.payload);
        return;
      }
      if (msg.type === 'hello' && this.isTop) {
        // 子 frame 宣告自己存在，带上能力信息
        this.onHello && this.onHello(msg.from, msg.caps || {});
        return;
      }
      if (msg.type === 'bye' && this.isTop) this.onBye(msg.from);
      if (msg.type === 'toast' && this.isTop) this.onToast(msg.from, msg.text);
      if (msg.type === 'pick' && this.isTop) this.onPick(msg.from, !!msg.active);
    }

    emit(obj) {
      const message = Object.assign({ from: this.frameId }, obj);
      if (this.useRuntime) {
        try { chrome.runtime.sendMessage({ type: 'frame-bus', message }).catch(() => {}); } catch (_) {}
        return;
      }
      if (!this.ch) return;
      try {
        this.ch.postMessage(message);
      } catch (e) {
        /* ignore */
      }
    }

    /** 顶层下发命令 */
    send(action, payload, target) {
      this.emit({ type: 'cmd', action, payload: payload || {}, target: target || null });
    }

    /** 子 frame 上报状态 */
    report(payload) {
      this.emit({ type: 'status', payload });
    }

    /** 子 frame 宣告存在 */
    hello(caps) {
      this.emit({ type: 'hello', caps: caps || {} });
    }

    bye() { this.emit({ type: 'bye' }); }

    close() {
      if (this.runtimeListener) chrome.runtime.onMessage.removeListener(this.runtimeListener);
      try {
        this.ch && this.ch.close();
      } catch (e) {
        /* ignore */
      }
    }
  }

  CAH.Bus = Bus;
})();
