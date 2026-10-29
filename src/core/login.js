/* 自动登录：识别学号/姓名表单并填写提交。
   凭据只从 chrome.storage 读取，不写死在代码里。 */
(function () {
  const CAH = (globalThis.__CAH__ = globalThis.__CAH__ || {});
  const U = CAH.util;
  const F = CAH.fill;

  // 中文标签与英文属性分开匹配：英文里 "sname"/"username" 都含 name，
  // 直接用 /name/ 会把学号框也当成姓名框。
  const ID_HINT_CN = /(学号|学籍号|工号|账号|帐号|用户名)/;
  const ID_HINT_EN = /(\busername\b|\buser_name\b|\blogin_?id\b|\bstudent_?id\b|\baccount\b|\buserid\b)/i;
  const NAME_HINT_CN = /(姓名|名字|真实姓名)/;
  const NAME_HINT_EN = /(\bfull_?name\b|\breal_?name\b|\bdisplay_?name\b|(?<!user)(?<!student)\bname\b)/i;
  const ID_HINT = /(学号|学籍号|工号|账号|帐号|用户名|\busername\b|\blogin_?id\b|\bstudent_?id\b|\baccount\b|\buser_?id\b)/i;
  const NAME_HINT = /(姓名|名字|真实姓名|\bfull_?name\b|\breal_?name\b)/i;
  const SUBMIT_HINT = /(^|\s)(登录|登陆|log\s*in|login|sign\s*in|submit|确定|进入|下一步)(\s|$)/i;
  const PASSWORD_HINT = /(密码|password|passwd)/i;

  /**
   * 收集输入框附近的提示文字。真实表单常这样写：
   *   <label>请输入学号 *</label><input />
   * 标签和输入框可能是兄弟节点，也可能包在同一个字段容器里，
   * 所以既看 label[for]，也向上找最近 3 层容器的文本。
   */
  function hintOf(el) {
    const parts = [
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('name') || '',
      el.id || '',
      el.getAttribute('autocomplete') || '',
      el.getAttribute('title') || ''
    ];

    // label[for=id]
    if (el.id) {
      try {
        for (const lab of document.querySelectorAll('label[for="' + CSS.escape(el.id) + '"]')) {
          parts.push(U.textOf(lab));
        }
      } catch (e) {
        /* ignore */
      }
    }
    // 被 label 包裹
    const wrapLabel = el.closest('label');
    if (wrapLabel) parts.push(U.textOf(wrapLabel));

    // 向上 3 层找字段容器，取它自己的文本（去掉输入框自身的值）
    let cur = el.parentElement;
    for (let i = 0; i < 3 && cur; i++) {
      const t = U.textOf(cur);
      if (t) parts.push(t.slice(0, 80));
      cur = cur.parentElement;
    }
    return parts.join(' ');
  }

  function textInputs() {
    // Coze 的智能体页用 <textarea id="Textarea1"> 做登录框，不是 input
    const sel =
      'input[type="text"], input[type="tel"], input[type="number"], input:not([type]), textarea';
    return Array.prototype.filter.call(document.querySelectorAll(sel), (el) => {
      if (!U.isVisible(el)) return false;
      if (el.disabled || el.readOnly) return false;
      if (el.closest('#cah-panel-host')) return false;
      const r = U.rectOf(el);
      return r.width > 60 && r.height > 14;
    });
  }

  function isPasswordField(el) {
    return (el.getAttribute('type') || '').toLowerCase() === 'password' || PASSWORD_HINT.test(hintOf(el));
  }

  function findSubmit() {
    const nodes = document.querySelectorAll('button, [role="button"], input[type="submit"], a');
    let best = null;
    let bestScore = 0;
    for (const el of nodes) {
      if (!U.isVisible(el) || el.closest('#cah-panel-host')) continue;
      const r = U.rectOf(el);
      if (r.width < 40 || r.height < 20 || r.width > 420 || r.height > 120) continue;
      const label = [U.textOf(el).slice(0, 30), el.getAttribute('aria-label') || '', el.getAttribute('value') || '', (el.className || '').toString()].join(' ');
      if (!SUBMIT_HINT.test(label)) continue;
      let score = 40;
      if (/^(登录|登陆|login|sign in)$/i.test(U.textOf(el).trim())) score += 30;
      if (el.tagName === 'BUTTON') score += 10;
      // 注意：禁用状态不能用来否定「这是登录按钮」。表单没填完时提交按钮
      // 本来就该是禁用的，扣分会让登录页直接识别不出来。禁用只影响后续能否点击。
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return bestScore >= 50 ? best : null;
  }

  /**
   * 识别登录表单。只有在「确实像登录页」时才返回，避免在聊天页误填。
   * 判据：存在提交按钮 + 至少一个文本输入框；或存在密码框 + 文本输入框。
   */
  function findLoginForm() {
    const inputs = textInputs().filter((el) => !isPasswordField(el));
    if (!inputs.length) return null;
    const submit = findSubmit();
    const hasPassword = textInputs().some(isPasswordField);
    if (!submit && !hasPassword) return null;

    // 优先按提示文字匹配。中文标签最可靠，其次才看 id/name 属性。
    const inputsAll = textInputs().filter((el) => !isPasswordField(el));
    let idEl = inputsAll.find((el) => ID_HINT.test(hintOf(el)) && !NAME_HINT.test(hintOf(el)));
    let nameEl = inputsAll.find((el) => NAME_HINT.test(hintOf(el)) && !ID_HINT.test(hintOf(el)));
    if (!idEl) idEl = inputsAll.find((el) => ID_HINT.test(hintOf(el)));
    if (!nameEl) nameEl = inputsAll.find((el) => el !== idEl && NAME_HINT.test(hintOf(el)));
    if (!idEl) {
      // 没有明确的学号框：取第一个非姓名输入
      idEl = inputsAll.find((el) => el !== nameEl) || null;
    }
    if (!idEl) return null;
    return { idInput: idEl, nameInput: nameEl || null, submitButton: submit };
  }

  function looksLikeLoginPage() {
    return !!findLoginForm();
  }

  function describeForm(form) {
    return {
      id: form.idInput ? U.describe(form.idInput) : null,
      name: form.nameInput ? U.describe(form.nameInput) : null,
      submit: form.submitButton ? U.describe(form.submitButton) : null
    };
  }

  /**
   * 尝试登录。凭据为空时直接返回 skipped。
   * 返回 { ok, reason, filled }
   */
  async function attemptLogin(settings, opts) {
    const options = opts || {};
    const studentId = String(settings.loginStudentId || '').trim();
    const name = String(settings.loginName || '').trim();
    if (!studentId && !name) return { ok: false, skipped: true, reason: '未配置学号/姓名' };

    const form = findLoginForm();
    if (!form) return { ok: false, reason: '没有找到登录表单' };

    const filled = [];
    if (studentId) {
      const r = await F.fill(form.idInput, studentId);
      filled.push({ field: '学号', ok: r.ok });
      if (!r.ok) return { ok: false, reason: '学号写入失败：' + r.reason, filled };
    }
    if (name && form.nameInput) {
      const r = await F.fill(form.nameInput, name);
      filled.push({ field: '姓名', ok: r.ok });
      if (!r.ok) return { ok: false, reason: '姓名写入失败：' + r.reason, filled };
    } else if (name && !form.nameInput) {
      filled.push({ field: '姓名', ok: false, note: '未找到姓名输入框' });
    }

    // 等按钮从禁用变可用
    await U.waitFor(() => form.submitButton && !U.isDisabled(form.submitButton), 1500, 100);

    if (!options.dryRun) {
      if (form.submitButton && !U.isDisabled(form.submitButton)) {
        F.click(form.submitButton);
      } else {
        const target = form.nameInput || form.idInput;
        target.focus();
        F.pressEnter(target);
      }
    }

    return { ok: true, filled, submit: form.submitButton ? U.describe(form.submitButton) : 'Enter' };
  }

  CAH.login = { findLoginForm, looksLikeLoginPage, attemptLogin, describeForm, findSubmit, textInputs };
})();
