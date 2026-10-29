/* 把文本写进输入框，并回读校验。
   关键点：React 受控组件必须走原型 setter；contenteditable 优先 execCommand。 */
(function () {
  const CAH = (globalThis.__CAH__ = globalThis.__CAH__ || {});
  const U = CAH.util;

  function nativeSetter(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
  }

  function fireInput(el, text) {
    el.dispatchEvent(
      new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text })
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function readBack(el) {
    if (!el) return '';
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value || '';
    return U.textOf(el);
  }

  // Normalize browser line endings, not the contents of code/string answers.
  function sameText(actual, expected) {
    const normalize = value => String(value == null ? '' : value)
      .replace(/\r\n?/g, '\n').replace(/\u00a0/g, ' ').trim();
    return normalize(actual) === normalize(expected);
  }

  async function fillTextarea(el, text) {
    el.focus();
    nativeSetter(el, '');
    fireInput(el, '');
    nativeSetter(el, text);
    fireInput(el, text);
    // 光标移到末尾，避免某些编辑器把插入点留在开头
    try {
      el.setSelectionRange(text.length, text.length);
    } catch (e) {
      /* 部分 type 不支持 */
    }
    return readBack(el);
  }

  async function fillContentEditable(el, text) {
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    // 清空选区内容
    document.execCommand('delete', false);
    const ok = document.execCommand('insertText', false, text);
    if (!ok || !U.textOf(el)) {
      // 退路：直接改 DOM 再派发 input，某些框架会把它当作粘贴处理
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    }
    return readBack(el);
  }

  /** 写入并校验。返回 {ok, actual} */
  async function fill(input, text) {
    if (!input) return { ok: false, actual: '', reason: '未找到输入框' };
    const tag = input.tagName.toLowerCase();
    let actual = '';
    try {
      if (tag === 'textarea' || tag === 'input') actual = await fillTextarea(input, text);
      else if (input.isContentEditable) actual = await fillContentEditable(input, text);
      else return { ok: false, actual: '', reason: '输入框类型不支持: ' + tag };
    } catch (e) {
      return { ok: false, actual: '', reason: '写入异常: ' + e.message };
    }
    await U.sleep(80);
    actual = readBack(input);
    if (!String(actual || '').trim()) return { ok: false, actual, reason: '写入后输入框为空' };
    if (!sameText(actual, text)) {
      return { ok: false, actual, reason: '回读内容与预期不一致' };
    }
    return { ok: true, actual };
  }

  function pressEnter(el) {
    const target = el || document.activeElement || document.body;
    const init = {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keypress', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  function click(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'nearest' });
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, composed: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, composed: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
    el.click();
    return true;
  }

  CAH.fill = { fill, click, pressEnter, readBack, sameText, isDisabled: U.isDisabled };
})();
