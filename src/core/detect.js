/* 启发式 DOM 定位。不依赖 Coze 的具体类名，改版后仍大概率可用。 */
(function () {
  const CAH = (globalThis.__CAH__ = globalThis.__CAH__ || {});
  const U = CAH.util;

  const INPUT_SEL = 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"], [role="combobox"]';
  const SEND_HINT = /(send|发送|提交|submit|send-button|btn-send)/i;
  const OTHER_ACTION_HINT = /(microphone|upload|attachment|attach[-_]|coz_plus_circle|coz_broom|coz_stop_circle|chat-clear|record|voice|语音|录音|上传|附件|清空)/i;
  const ONBOARDING_SEL = '[data-testid="bot.ide.chat_area.onboarding_content"]';
  const USER_CONTENT_SEL = '[data-testid="chat_area.message.text-input-message-content"]';
  const ASSISTANT_CONTENT_SEL = '[data-testid="bot.ide.chat_area.message.text-answer-message-content"]';

  function messageContent(row, selector) {
    return row && (row.matches(selector) ? row : row.querySelector(selector));
  }

  function messageText(row) {
    return U.textOf(messageContent(row, USER_CONTENT_SEL) || messageContent(row, ASSISTANT_CONTENT_SEL) || row);
  }

  function messageRole(row) {
    if (!row) return '';
    if (messageContent(row, USER_CONTENT_SEL + ', [data-testid="chat_area.message.text-input-message"]')) return 'user';
    if (messageContent(row, ASSISTANT_CONTENT_SEL) || row.closest(ONBOARDING_SEL)) return 'assistant';
    return '';
  }

  function messageFailed(row) {
    return messageRole(row) === 'user' && !!row.querySelector('[class*="icon-fail"]');
  }

  // Coze SDK exposes stable message markers even when its CSS class hashes change.
  // The composer and footer share a deep ancestor with this area, so that ancestor
  // must not be treated as one message or skipped merely because it has a textarea.
  function findMarkedMessageList() {
    const roots = document.querySelectorAll('[data-scroll-element="scrollable"], [data-testid="chat-area.message-content"], [role="log"]');
    const candidates = Array.from(roots).filter((el) =>
      U.isVisible(el) && !isOurs(el) && !isNavLike(el) &&
      el.querySelector('[data-message-id], ' + ONBOARDING_SEL)
    );
    candidates.sort((a, b) =>
      Number(b.matches('[data-scroll-element="scrollable"]')) - Number(a.matches('[data-scroll-element="scrollable"]'))
    );
    return candidates[0] || null;
  }

  function viewportArea(el) {
    const r = U.rectOf(el);
    const w = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0));
    const h = Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
    return w * h;
  }

  /** 插件自己的面板、拾取遮罩等，绝不能参与识别 */
  function isOurs(el) {
    if (!el) return false;
    try {
      if (el.closest && el.closest('#cah-panel-host')) return true;
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  /** 递归检查自身及后代是否含插件元素 */
  function containsOurs(el) {
    if (isOurs(el)) return true;
    return false;
  }

  function isEditable(el) {
    if (!el) return false;
    const t = el.tagName.toLowerCase();
    if (t === 'textarea') return !el.readOnly;
    if (el.isContentEditable) return true;
    if (t === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      return !el.readOnly && ['text', 'search', 'url', 'email', ''].includes(type);
    }
    return false;
  }

  /** 找到包含消息的滚动容器：可见、可滚动、面积足够大、文本足够多 */
  function findScrollContainer() {
    const marked = findMarkedMessageList();
    if (marked) return marked;
    const all = document.querySelectorAll('div, main, section, ul, ol');
    const scored = [];
    for (const el of all) {
      if (!U.isVisible(el)) continue;
      if (isNavLike(el)) continue;
      if (isOurs(el)) continue;
      const area = viewportArea(el);
      if (area < innerWidth * innerHeight * 0.1) continue;
      const cs = getComputedStyle(el);
      const oy = cs.overflowY;
      if (!/(auto|scroll|overlay)/.test(oy)) continue;
      const overflow = el.scrollHeight - el.clientHeight;
      const text = U.textOf(el);
      if (text.length < 40) continue;
      let score = Math.min(area / (innerWidth * innerHeight), 1) * 45;
      score += Math.min(text.length / 400, 10);
      score += Math.min(Math.max(overflow, 0) / 100, 8);
      // 排除过窄的侧栏
      const r = U.rectOf(el);
      if (r.width < innerWidth * 0.35) score -= 30;
      // 页面主内容通常在中间/右侧，且更靠近底部
      if (r.left >= innerWidth * 0.15) score += 5;
      scored.push({ el, score, text });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored[0] && scored[0].score > 18 ? scored[0].el : null;
  }

  const NAV_TAGS = new Set(['ASIDE', 'NAV', 'HEADER', 'FOOTER']);
  const NAV_ROLES = new Set(['navigation', 'complementary', 'banner', 'contentinfo', 'menu', 'menubar', 'tablist']);

  function isNavLike(el) {
    let cur = el;
    for (let i = 0; i < 4 && cur && cur.nodeType === 1; i++) {
      if (NAV_TAGS.has(cur.tagName)) return true;
      const role = (cur.getAttribute('role') || '').toLowerCase();
      if (NAV_ROLES.has(role)) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  /**
   * 这个元素是否像「一条消息」。
   * Coze 的空隙容器常把工具栏按钮和聊天区放在同一层：
   *   <div id="Page5">
   *     <div class="scrollable">聊天区</div>
   *     <button>查看排行</button>
   *     <button>返回上一页</button>
   * 直接把「有 3 个垂直子元素」当成消息列表就会选到 Page5。
   */
  /**
   * 这个元素像不像「一条消息」。
   *
   * Coze 真实页面的 #Page5 是这样的：
   *   <div id="Page5">
   *     <div class="chat-area">   ← 整块聊天卡片，内部还有多条消息
   *     <button>查看排行</button>
   *     <button>返回上一页</button>
   *   </div>
   * 长文本不能单凭长度就通过——chat-area 的文本当然很长。
   * 判据改成：不像控件 + 有正常对话长度 + 内部没有「多条并列的消息块」。
   */
  function looksLikeMessageRow(el) {
    const text = U.textOf(el);
    if (!text) return false;

    // 控件一律不算消息
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'TEXTAREA') return false;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'button' || role === 'tab' || role === 'menuitem' || role === 'option') return false;
    if (U.isDisabled(el)) return false;

    // 短文本：几乎必然是标签/按钮
    if (text.length < 6) return false;

    // 内部还包着多个「各自独立、都有文本」的子块 —— 说明这是个容器，不是一条消息
    const kids = Array.prototype.filter.call(el.children, (c) => U.isVisible(c) && U.textOf(c).length > 0);
    if (kids.length >= 2) {
      const kidLens = kids.map((c) => U.textOf(c).length);
      const longKids = kidLens.filter((n) => n >= 12).length;
      // 至少两个子块都像正文，才认为它是容器
      if (longKids >= 2) return false;
    }
    return true;
  }

  /** 一组子元素里，有多大比例真的像消息 */
  function messagePurity(kids) {
    if (!kids.length) return 0;
    const good = kids.filter(looksLikeMessageRow).length;
    return good / kids.length;
  }

  /** 在容器内寻找“子元素并列”的列表，按子元素数 / 高度覆盖 / 文本量打分 */
  function findMessageList() {
    const marked = findMarkedMessageList();
    if (marked) return marked;
    const container = findScrollContainer() || document.body;
    const candidates = [];
    const walk = (root, depth) => {
      if (depth > 6) return;
      for (const el of root.children) {
        if (!U.isVisible(el) || isNavLike(el) || isOurs(el)) continue;
        // The composer shares ancestors with the chat. Search those ancestors'
        // children without treating the entire editor-containing shell as a list.
        if (isEditable(el)) continue;
        if (el.querySelector('textarea, [contenteditable="true"]')) {
          walk(el, depth + 1);
          continue;
        }
        const kids = Array.prototype.filter.call(el.children, (c) => U.isVisible(c));
        if (kids.length >= 2) {
          const texts = kids.map((c) => U.textOf(c)).filter((t) => t.length > 0);
          if (texts.length >= 2) {
            const purity = messagePurity(kids);
            // 子元素大多是按钮/短标签的，不是消息列表
            if (purity < 0.6) {
              walk(el, depth + 1);
              continue;
            }

            // 关键：如果「像消息」的子元素全都被某个子元素包着（典型是 chat-area
            // 包住所有消息），那这一层只是个外壳，真正的列表在更深处。
            const goodKids = kids.filter(looksLikeMessageRow);
            const hasBigContainer = kids.some(
              (c) => !looksLikeMessageRow(c) && U.textOf(c).length > 40
            );
            const onlyOneReal = goodKids.length <= 1;
            if (hasBigContainer && onlyOneReal) {
              walk(el, depth + 1);
              continue;
            }

            const r = U.rectOf(el);
            const cover = container.clientHeight ? Math.min(r.height / container.clientHeight, 1) : 0;
            const vertical = kids.filter((c) => {
              const cs = getComputedStyle(c);
              return cs.display !== 'inline' && U.rectOf(c).height > 10;
            }).length;
            const totalLen = texts.join('').length;
            const avg = totalLen / Math.max(texts.length, 1);
            const score =
              vertical * 2 +
              cover * 20 +
              Math.min(totalLen / 300, 10) +
              (el.parentElement === container ? 6 : 0) +
              purity * 12 +
              (avg > 8 ? 4 : 0);
            candidates.push({ el, score, vertical, purity });
          }
        }
        walk(el, depth + 1);
      }
    };
    walk(container, 0);
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    if (!best || best.vertical < 2) {
      // 兜底：容器只有一个子 wrapper 时，向下找第一层有 ≥2 个可见子元素的后代
      const fallback = findListFallback(container);
      return fallback || (container.querySelector('textarea, [contenteditable="true"]') ? null : container);
    }
    return best.el;
  }

  function findListFallback(container) {
    const queue = [container];
    let best = null;
    while (queue.length) {
      const el = queue.shift();
      if (isNavLike(el) || isOurs(el)) continue;
      let visible = Array.prototype.filter.call(el.children, (c) => U.isVisible(c) && U.textOf(c).length > 0);
      if (visible.length >= 2 && !el.querySelector('textarea, [contenteditable="true"]') && messagePurity(visible) >= 0.6) {
        const avg = visible.reduce((n, c) => n + U.textOf(c).length, 0) / visible.length;
        const score = visible.length * 2 + Math.min(U.rectOf(el).height / Math.max(innerHeight, 1), 1) * 20 + (avg > 8 ? 6 : 0);
        if (!best || score > best.score) best = { el, score };
      }
      for (const c of el.children) if (U.isVisible(c)) queue.push(c);
      if (queue.length > 200) break;
    }
    return best ? best.el : null;
  }

  /** 消息行：列表直接子元素；只有 1 个就向下递归（虚拟列表常见单层 wrapper） */
  function getMessageRows(list) {
    if (!list) return [];
    const marked = Array.from(list.querySelectorAll('[data-message-id]')).filter((el) =>
      U.isVisible(el) && U.textOf(el) && !el.parentElement.closest('[data-message-id]')
    );
    // The real SDK reverses both groups and messages with column-reverse. Sorting
    // the individual message rectangles yields oldest -> newest across both levels.
    if (marked.length) return marked.sort((a, b) => U.rectOf(a).top - U.rectOf(b).top);
    // SDK welcome messages deliberately have NO_MESSAGE_ID. Read the prologue,
    // excluding the bot title, and stop using it once real message IDs exist.
    const onboarding = list.matches(ONBOARDING_SEL) ? list : list.querySelector(ONBOARDING_SEL);
    if (onboarding && U.isVisible(onboarding)) {
      const prologue = onboarding.querySelector('.chat-uikit-on-boarding__prologue') || onboarding;
      return U.textOf(prologue) ? [prologue] : [];
    }
    let rows = Array.prototype.filter.call(list.children, (c) => U.isVisible(c) && U.textOf(c).length > 0);
    if (rows.length >= 2) return rows;
    let cur = rows[0] || list;
    for (let i = 0; i < 3; i++) {
      const next = Array.prototype.filter.call(cur.children, (c) => U.isVisible(c) && U.textOf(c).length > 0);
      if (next.length >= 2) return next;
      if (next.length === 0) break;
      cur = next[0];
    }
    return rows;
  }

  /** 输入框：可见、可编辑、最贴近页面底部、尺寸合理 */
  function findInput() {
    const all = Array.prototype.filter.call(
      document.querySelectorAll(INPUT_SEL),
      (el) => U.isVisible(el) && isEditable(el) && !isOurs(el)
    );
    if (!all.length) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const el of all) {
      const r = U.rectOf(el);
      if (r.width < 80 || r.height < 14) continue;
      if (r.height > Math.min(innerHeight * 0.6, 500)) continue;
      let score = (r.bottom / innerHeight) * 50; // 越靠下越好
      score += Math.min((r.width * r.height) / 8000, 10);
      if (r.top > innerHeight * 0.4) score += 12;
      // 页面顶部/导航里的搜索框降权
      if (r.top < 120) score -= 40;
      if (el.tagName.toLowerCase() === 'input') score -= 35;
      // 富文本编辑器常见标记
      if (el.isContentEditable) score += 6;
      if (/placeholder|输入|发送消息|ask|message/i.test(el.getAttribute('placeholder') || '')) score += 8;
      score += Math.min(U.textOf(el).length / 50, 2);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  /** 发送按钮：输入框容器附近、标签/类名像发送、未禁用 */
  function findSendButton(input) {
    if (!input) return null;
    const inputRect = U.rectOf(input);
    const scopes = [];
    let cur = input;
    for (let i = 0; i < 5 && cur; i++) {
      scopes.push(cur);
      cur = cur.parentElement;
    }
    scopes.push(document.body);

    const seen = new Set();
    let best = null;
    let bestScore = 0;
    for (const scope of scopes) {
      let nodes;
      try {
        nodes = scope.querySelectorAll(
          'button, [role="button"], input[type="submit"], [class*="send" i], [aria-label*="send" i], [title*="发送"], [data-testid*="send" i], [class*="submit" i]'
        );
      } catch (e) {
        continue;
      }
      for (const el of nodes) {
        if (seen.has(el) || !U.isVisible(el)) continue;
        seen.add(el);
        const r = U.rectOf(el);
        if (r.width < 12 || r.height < 12 || r.width > 140 || r.height > 140) continue;
        // 必须靠近输入框
        const near =
          r.top > inputRect.top - 120 && r.bottom < inputRect.bottom + 80 && Math.abs(r.left - inputRect.right) < 260;
        // Upload and microphone controls occupy the send button's position while
        // the editor is empty. Their icon semantics take precedence over geometry.
        if (el.querySelector('button, [role="button"]')) continue;
        const label = [
          el.getAttribute('aria-label') || '',
          el.getAttribute('title') || '',
          el.getAttribute('data-testid') || '',
          (el.className || '').toString(),
          el.id || '',
          U.textOf(el).slice(0, 20),
          ...Array.from(el.querySelectorAll('svg, use')).map(icon =>
            (icon.getAttribute('class') || '') + ' ' + (icon.getAttribute('href') || ''))
        ].join(' ');
        if (OTHER_ACTION_HINT.test(label)) continue;
        let score = 0;
        if (SEND_HINT.test(label)) score += 40;
        if (near) score += 25;
        if (el.tagName === 'BUTTON') score += 8;

        // Coze 的发送按钮常常是纯图标：无文字、无 aria-label，只有 svg 或 ↑ 符号。
        // 这类按钮靠「贴着输入框右下角、尺寸小、在输入框之后」来认。
        const iconOnly = !U.textOf(el) || U.textOf(el).length <= 2;
        const besideInput =
          Math.abs(r.top + r.height / 2 - (inputRect.top + inputRect.height / 2)) < inputRect.height + 30 &&
          r.left >= inputRect.left;
        const hasSvg = !!el.querySelector('svg, img, [class*="icon" i]');
        if (iconOnly && besideInput) score += 18;
        if (hasSvg) score += 12;
        if (iconOnly && besideInput && hasSvg) score += 10;

        // 禁用状态只降低优先级，完全不排除（输入框为空时本来就该禁用）
        if (U.isDisabled(el)) score -= 12;

        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
    }
    // 放宽阈值：纯图标按钮没有语义标签，靠位置和形状拿到 40 分左右
    if (bestScore < 40) return null;
    return { el: best, disabled: U.isDisabled(best) };
  }

  function dumpDebug() {
    const list = findMessageList();
    const rows = getMessageRows(list);
    const input = findInput();
    const send = findSendButton(input);
    const container = findScrollContainer();
    return {
      build: CAH.BUILD || 'unknown',
      url: location.href,
      time: new Date().toISOString(),
      container: container ? { path: U.cssPath(container), desc: U.describe(container) } : null,
      list: list ? { path: U.cssPath(list), desc: U.describe(list), rows: rows.length } : null,
      input: input ? { path: U.cssPath(input), desc: U.describe(input), tag: input.tagName } : null,
      send: send ? { path: U.cssPath(send.el), desc: U.describe(send.el), disabled: send.disabled } : null,
      lastRowHtml: rows.length ? rows[rows.length - 1].outerHTML.slice(0, 4000) : '',
      lastRowText: rows.length ? messageText(rows[rows.length - 1]).slice(0, 800) : ''
    };
  }

  /** 诊断：把识别过程和打分明细摊开，用于在真实页面上定位问题 */
  function diagnose() {
    const out = { build: CAH.BUILD || 'unknown', url: location.href, steps: [] };

    // 0) 登录表单
    if (CAH.login) {
      const form = CAH.login.findLoginForm();
      out.steps.push({
        step: '登录表单',
        result: form ? '识别到' : findInput() ? '当前为聊天页（无需登录表单）' : '未识别到',
        form: form ? CAH.login.describeForm(form) : null,
        inputs: CAH.login.textInputs().map((el) => {
          const r = U.rectOf(el);
          return {
            tag: el.tagName,
            type: el.getAttribute('type') || '(none)',
            placeholder: el.getAttribute('placeholder') || '',
            id: el.id || '',
            name: el.getAttribute('name') || '',
            label: (el.parentElement ? U.textOf(el.parentElement) : '').slice(0, 30),
            visible: r.width > 0 && r.height > 0
          };
        }),
        submit: form ? (CAH.login.findSubmit() ? U.describe(CAH.login.findSubmit()) : '未找到') : '不适用'
      });
    }

    // 1) 滚动容器
    const all = document.querySelectorAll('div, main, section, ul, ol');
    const containers = [];
    for (const el of all) {
      if (!U.isVisible(el) || isNavLike(el) || isOurs(el)) continue;
      const area = viewportArea(el);
      if (area < innerWidth * innerHeight * 0.1) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll|overlay)/.test(cs.overflowY)) continue;
      const text = U.textOf(el);
      if (text.length < 40) continue;
      const r = U.rectOf(el);
      let score = Math.min(area / (innerWidth * innerHeight), 1) * 45;
      score += Math.min(text.length / 400, 10);
      score += Math.min(Math.max(el.scrollHeight - el.clientHeight, 0) / 100, 8);
      if (r.width < innerWidth * 0.35) score -= 30;
      if (r.left >= innerWidth * 0.15) score += 5;
      containers.push({ path: U.cssPath(el), score: Math.round(score), w: Math.round(r.width), h: Math.round(r.height), textLen: text.length });
    }
    containers.sort((a, b) => b.score - a.score);
    const container = findScrollContainer();
    out.steps.push({
      step: '滚动容器',
      result: container ? U.describe(container) : '未找到',
      threshold: 18,
      top: containers.slice(0, 5)
    });

    // 2) 消息列表候选
    const cands = [];
    const walk = (root, depth) => {
      if (depth > 4) return;
      for (const el of root.children) {
        if (!U.isVisible(el) || isNavLike(el) || isOurs(el)) continue;
        if (isEditable(el)) continue;
        if (el.querySelector('textarea, [contenteditable="true"]')) {
          walk(el, depth + 1);
          continue;
        }
        const kids = Array.prototype.filter.call(el.children, (c) => U.isVisible(c));
        if (kids.length >= 2) {
          const texts = kids.map((c) => U.textOf(c)).filter((t) => t.length > 0);
          if (texts.length >= 2) {
            const r = U.rectOf(el);
            const cover = container && container.clientHeight ? Math.min(r.height / container.clientHeight, 1) : 0;
            const vertical = kids.filter((c) => getComputedStyle(c).display !== 'inline' && U.rectOf(c).height > 10).length;
            const avg = texts.join('').length / Math.max(texts.length, 1);
            cands.push({
              path: U.cssPath(el),
              score: Math.round(vertical * 2 + cover * 20 + Math.min(texts.join('').length / 300, 10) + (el.parentElement === container ? 6 : 0) + (avg > 8 ? 4 : 0)),
              kids: kids.length,
              vertical,
              sample: texts[0].slice(0, 40)
            });
          }
        }
        walk(el, depth + 1);
      }
    };
    walk(container || document.body, 0);
    cands.sort((a, b) => b.score - a.score);
    const list = findMessageList();
    const rows = getMessageRows(list);
    out.steps.push({
      step: '消息列表',
      result: list ? U.describe(list) : '未找到',
      rows: rows.length,
      top: cands.slice(0, 6)
    });

    // 3) 消息行内容
    out.steps.push({
      step: '消息行',
      total: rows.length,
      last5: rows.slice(-5).map((r) => messageText(r).slice(0, 90))
    });

    // 4) 输入框候选
    const inputs = Array.prototype.filter
      .call(document.querySelectorAll(INPUT_SEL), (el) => U.isVisible(el) && isEditable(el) && !isOurs(el))
      .map((el) => {
        const r = U.rectOf(el);
        return { path: U.cssPath(el), tag: el.tagName, bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
      })
      .sort((a, b) => b.bottom - a.bottom)
      .slice(0, 6);
    const input = findInput();
    out.steps.push({ step: '输入框', result: input ? U.describe(input) : '未找到', candidates: inputs });

    // 5) 发送按钮
    const send = findSendButton(input);
    out.steps.push({ step: '发送按钮', result: send ? U.describe(send.el) : '未找到（将退回 Enter）' });

    // 6) 分类结果
    if (rows.length) {
      const lastText = messageText(rows[rows.length - 1]);
      out.steps.push({
        step: '分类',
        lastText: lastText.slice(0, 200),
        isQuestion: looksLikeQuestionSafe(lastText),
        isStart: CAH.classify && CAH.classify.isStartPrompt ? CAH.classify.isStartPrompt(lastText) : false,
        isContinue: isContinueSafe(lastText),
        isFeedback: isFeedbackSafe(lastText)
      });
    }

    return out;
  }

  // 分类函数在 engine.js 里，这里做软引用，未加载时返回 null
  function looksLikeQuestionSafe(t) {
    return CAH.classify ? CAH.classify.looksLikeQuestion(t) : null;
  }
  function isContinueSafe(t) {
    return CAH.classify ? CAH.classify.isContinuePrompt(t, CAH.classify.buildPatterns(CAH.defaults ? CAH.defaults.DEFAULTS : {})) : null;
  }
  function isFeedbackSafe(t) {
    return CAH.classify && CAH.classify.isFeedback ? CAH.classify.isFeedback(t) : null;
  }

  CAH.detect = {
    findScrollContainer,
    findMessageList,
    getMessageRows,
    messageText,
    messageRole,
    messageFailed,
    findInput,
    findSendButton,
    isEditable,
    dumpDebug,
    diagnose
  };
})();
