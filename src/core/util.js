/* DOM / 文本基础工具。无 chrome 依赖，可在普通页面里直接测试。 */
(function () {
  const CAH = (globalThis.__CAH__ = globalThis.__CAH__ || {});

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  }

  function textOf(el) {
    if (!el) return '';
    const raw = el.innerText != null ? el.innerText : el.textContent || '';
    return raw
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function norm(s) {
    return String(s || '').replace(/\s+/g, '').toLowerCase();
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  const SKIP_CLASS = /^(semi-|coz-|app--|css-|sc-|ant-|el-)/;

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) {
      const idSel = '#' + CSS.escape(el.id);
      try {
        if (document.querySelectorAll(idSel).length === 1) return idSel;
      } catch (e) {
        /* 忽略非法 id */
      }
    }
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 8; depth++) {
      let part = cur.tagName.toLowerCase();
      for (const c of cur.classList) {
        if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(c)) continue;
        if (SKIP_CLASS.test(c)) continue;
        part += '.' + CSS.escape(c);
        break;
      }
      const parent = cur.parentElement;
      if (!parent || parent === document.documentElement) {
        parts.unshift(part);
        break;
      }
      const sameTag = Array.prototype.filter.call(parent.children, (x) => x.tagName === cur.tagName);
      if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(cur) + 1) + ')';
      parts.unshift(part);
      const sel = parts.join(' > ');
      try {
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (e) {
        /* 继续向上拼 */
      }
      cur = parent;
    }
    return parts.join(' > ');
  }

  function queryPath(path) {
    if (!path) return null;
    try {
      const el = document.querySelector(path);
      return el && el.isConnected ? el : null;
    } catch (e) {
      return null;
    }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitFor(fn, timeout = 3000, interval = 100) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        if (fn()) return true;
      } catch (e) {
        /* 忽略单次异常 */
      }
      await sleep(interval);
    }
    return false;
  }

  function describe(el) {
    if (!el) return 'null';
    const cls = (el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
    return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
  }

  function rectOf(el) {
    return el ? el.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }

  function isDisabled(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    const cls = (el.className || '').toString();
    if (/(^|[\s-])(disabled|is-disabled)([\s-]|$)/i.test(cls)) return true;
    const cs = getComputedStyle(el);
    if (cs.pointerEvents === 'none') return true;
    if (parseFloat(cs.opacity) < 0.25) return true;
    return false;
  }

  CAH.util = { isVisible, textOf, norm, hash, cssPath, queryPath, sleep, waitFor, describe, rectOf, isDisabled };
})();
