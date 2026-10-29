/* 设置页逻辑。背景页用 service worker，这里直接走同源权限校验 + 消息。 */
(function () {
  const CAH = globalThis.__CAH__;
  const { DEFAULTS, withDefaults, PRESETS } = CAH.defaults;

  const $ = (id) => document.getElementById(id);
  const fields = [
    'provider', 'baseUrl', 'model', 'apiKey', 'temperature', 'maxTokens', 'systemPrompt',
    'autoGenerate', 'autoFill', 'requireConfirm', 'autoAdvance', 'autoSwitchChapter', 'advanceText', 'advancePatterns',
    'maxRounds', 'stabilizeMs', 'actionDelayMs',
    'loginStudentId', 'loginName', 'autoLogin', 'loginAutoSubmit'
  ];
  const overrideFields = { messageList: 'ovMessageList', input: 'ovInput', sendButton: 'ovSend' };

  let settings = withDefaults({});

  function fillPresets() {
    const sel = $('preset');
    sel.innerHTML = '<option value="">自定义</option>';
    for (const p of PRESETS) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.label + ' · ' + p.model;
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      const p = PRESETS.find((x) => x.id === sel.value);
      if (!p) return;
      $('provider').value = p.provider;
      $('baseUrl').value = p.baseUrl;
      $('model').value = p.model;
    });
  }

  function readEnvConfig() {
    // 用户把自己的配置放在 tools/env.local.json（该文件已被 .gitignore 忽略）
    // 格式：{ baseUrl, apiKey, model, provider }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.provider) $('provider').value = data.provider;
        if (data.baseUrl) $('baseUrl').value = data.baseUrl;
        if (data.model) $('model').value = data.model;
        if (data.apiKey) $('apiKey').value = data.apiKey;
        if (data.systemPrompt) $('systemPrompt').value = data.systemPrompt;
        if (data.loginStudentId) $('loginStudentId').value = data.loginStudentId;
        if (data.loginName) $('loginName').value = data.loginName;
        if (data.autoLogin !== undefined) $('autoLogin').checked = !!data.autoLogin;
        if (data.loginAutoSubmit !== undefined) $('loginAutoSubmit').checked = !!data.loginAutoSubmit;
        save();
        status('已导入配置，请点「授权访问接口地址」', 'ok');
      } catch (e) {
        status('读取失败：' + e.message, 'err');
      }
    });
    input.click();
  }

  function load() {
    chrome.storage.local.get('settings', (got) => {
      settings = withDefaults(got && got.settings);
      for (const k of fields) {
        const el = $(k);
        if (!el) continue;
        if (el.type === 'checkbox') el.checked = !!settings[k];
        else el.value = settings[k] == null ? '' : settings[k];
      }
      for (const [k, id] of Object.entries(overrideFields)) $(id).value = settings.overrides[k] || '';
      // 高亮匹配的预设
      const match = PRESETS.find((p) => p.baseUrl === settings.baseUrl && p.model === settings.model);
      $('preset').value = match ? match.id : '';
    });
  }

  function collect() {
    const s = withDefaults(settings);
    for (const k of fields) {
      const el = $(k);
      if (!el) continue;
      if (el.type === 'checkbox') s[k] = el.checked;
      else if (el.type === 'number') s[k] = el.value === '' ? DEFAULTS[k] : Number(el.value);
      else s[k] = el.value;
    }
    s.overrides = {
      messageList: $('ovMessageList').value.trim(),
      input: $('ovInput').value.trim(),
      sendButton: $('ovSend').value.trim()
    };
    return s;
  }

  function status(text, kind) {
    const el = $('status');
    el.textContent = text;
    el.className = kind || '';
  }

  function save() {
    settings = collect();
    chrome.storage.local.set({ settings }, () => {
      $('saveStatus').textContent = '已保存 ' + new Date().toLocaleTimeString();
      setTimeout(() => ($('saveStatus').textContent = ''), 3000);
    });
  }

  function originOf(url) {
    try {
      return new URL(url).origin + '/*';
    } catch (e) {
      return null;
    }
  }

  async function grant() {
    const s = collect();
    const origin = originOf(s.baseUrl);
    if (!origin) {
      status('接口地址不是合法 URL', 'err');
      return;
    }
    try {
      const granted = await chrome.permissions.request({ origins: [origin] });
      status(granted ? '已授权访问 ' + origin : '用户取消了授权', granted ? 'ok' : 'warn');
    } catch (e) {
      status('授权失败：' + e.message + '（需要用户手势触发，请再点一次）', 'err');
    }
  }

  async function test() {
    const s = collect();
    status('测试中…', '');
    const origin = originOf(s.baseUrl);
    if (!origin) {
      status('接口地址不是合法 URL', 'err');
      return;
    }
    const has = await chrome.permissions.contains({ origins: [origin] });
    if (!has) {
      status('还没有授权访问 ' + origin + '，请先点「授权访问接口地址」', 'warn');
      return;
    }
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'test', settings: s });
    } catch (e) {
      status('后台无响应：' + e.message, 'err');
      return;
    }
    if (res && res.ok) status('连接成功，返回答案：' + res.answer, 'ok');
    else status('失败：' + ((res && res.error) || '未知错误'), 'err');
  }

  function exportConfig() {
    const s = collect();
    const clone = Object.assign({}, s, { apiKey: '' });
    const blob = new Blob([JSON.stringify(clone, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'coze-answer-helper-config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  function importConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        settings = withDefaults(data);
        // 导入不带 Key，保留当前 Key
        chrome.storage.local.get('settings', (got) => {
          const cur = withDefaults(got && got.settings);
          settings.apiKey = cur.apiKey;
          chrome.storage.local.set({ settings }, load);
        });
      } catch (e) {
        status('导入失败：' + e.message, 'err');
      }
    });
    input.click();
  }

  fillPresets();
  load();
  $('save').addEventListener('click', save);
  $('grant').addEventListener('click', grant);
  $('test').addEventListener('click', test);
  $('export').addEventListener('click', exportConfig);
  $('import').addEventListener('click', importConfig);
  $('loadLocal').addEventListener('click', readEnvConfig);

  // 自动保存（防误关）
  let t = null;
  document.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(save, 900);
  });
  document.addEventListener('change', () => {
    clearTimeout(t);
    t = setTimeout(save, 300);
  });
})();
