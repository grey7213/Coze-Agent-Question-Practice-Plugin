/* 后台 service worker：唯一持有 API Key 的地方 */
importScripts('./shared/defaults.js');

const CAH = globalThis.__CAH__;
const DEFAULTS = CAH.defaults.DEFAULTS;

let initializingSettings = null;
function initializeSettings() {
  if (initializingSettings) return initializingSettings;
  initializingSettings = (async () => {
    const got = await chrome.storage.local.get('settings');
    const saved = got.settings || {};
    if (saved.apiKey && saved.loginStudentId) return CAH.defaults.withDefaults(saved);
    try {
      // This private extension resource is deliberately NOT web-accessible.
      const res = await fetch(chrome.runtime.getURL('tools/env.local.json'));
      if (!res.ok) return CAH.defaults.withDefaults(saved);
      const local = await res.json();
      const merged = Object.assign({}, local, saved);
      for (const key of Object.keys(local)) {
        if (merged[key] === '' || merged[key] == null) merged[key] = local[key];
      }
      merged.overrides = Object.assign({}, local.overrides || {}, saved.overrides || {});
      const settings = CAH.defaults.withDefaults(merged);
      await chrome.storage.local.set({ settings });
      return settings;
    } catch (_) {
      // Having no env.local.json is normal for a distributed extension.
      return CAH.defaults.withDefaults(saved);
    }
  })().finally(() => { initializingSettings = null; });
  return initializingSettings;
}

function publicSettings(settings) {
  const copy = Object.assign({}, settings);
  delete copy.apiKey;
  return copy;
}

const CONTENT_SETTING_KEYS = [
  'autoGenerate', 'autoFill', 'requireConfirm', 'autoAdvance', 'autoSwitchChapter', 'advanceText',
  'advancePatterns', 'stabilizeMs', 'actionDelayMs', 'maxRounds', 'overrides', 'panelOpen'
];

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (got) => {
      resolve(CAH.defaults.withDefaults(got && got.settings));
    });
  });
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'chapter-progress' && sender.tab && sender.id === chrome.runtime.id) {
    (async () => {
      const app = (sender.tab.url || sender.url || '').match(/\/(?:project|ui-builder-app)\/(\d+)/)?.[1] || 'local';
      const key = 'cah-chapters:' + sender.tab.id + ':' + app;
      if (msg.action === 'save') {
        const value = msg.progress || {};
        const progress = {};
        for (const field of ['phase', 'navigationStage', 'currentTopic', 'targetTopic', 'feedbackKey', 'error']) {
          progress[field] = String(value[field] || '').slice(0, 500);
        }
        progress.completed = Array.isArray(value.completed) ? value.completed.filter(x => typeof x === 'string').slice(0, 200).map(x => x.slice(0, 200)) : [];
        progress.rounds = Math.max(0, Number(value.rounds) || 0);
        progress.resume = value.resume === true;
        progress.needsNavigation = value.needsNavigation === true;
        await chrome.storage.session.set({ [key]: progress });
        return { ok: true };
      }
      const stored = await chrome.storage.session.get(key);
      return { ok: true, progress: stored[key] || null };
    })().then(sendResponse).catch(() => sendResponse({ ok: false, error: '章节进度读写失败' }));
    return true;
  }
  if (msg.type === 'frame-bus' && sender.tab && sender.id === chrome.runtime.id) {
    // tabs.sendMessage targets this tab only, including its content-script frames.
    chrome.tabs.sendMessage(sender.tab.id, { type: 'frame-bus', message: msg.message }).catch(() => {});
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === 'init-settings') {
    initializeSettings().then(settings => sendResponse({ ok: true, settings: publicSettings(settings) }))
      .catch(() => sendResponse({ ok: false, error: '读取本地设置失败' }));
    return true;
  }
  if (msg.type === 'update-content-settings') {
    (async () => {
      const settings = await getSettings();
      for (const key of CONTENT_SETTING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(msg.settings || {}, key)) settings[key] = msg.settings[key];
      }
      await chrome.storage.local.set({ settings });
      return { ok: true };
    })().then(sendResponse).catch(() => sendResponse({ ok: false, error: '保存设置失败' }));
    return true;
  }
  if (msg.type === 'ask') {
    handleAsk(msg).then(sendResponse);
    return true; // 异步
  }
  if (msg.type === 'test') {
    handleTest(msg).then(sendResponse);
    return true;
  }
  if (msg.type === 'open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return;
  }
});

function endpoint(settings) {
  const base = String(settings.baseUrl || '').replace(/\/+$/, '');
  if (settings.provider === 'anthropic') {
    return /\/v1\/messages$/.test(base) ? base : base + '/v1/messages';
  }
  return /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
}

function originPattern() {
  // 占位，实际在请求前用 settings.baseUrl 计算
  return null;
}

async function ensurePermission(baseUrl) {
  let origin;
  try {
    origin = new URL(baseUrl).origin + '/*';
  } catch (e) {
    return { ok: false, error: '接口地址不是合法 URL：' + baseUrl };
  }
  const has = await chrome.permissions.contains({ origins: [origin] });
  if (!has) {
    return {
      ok: false,
      error: '还没有授权访问 ' + origin + '。请打开扩展设置页，点击「授权访问接口地址」。',
      needsPermission: origin
    };
  }
  return { ok: true };
}

function buildMessages(settings, payload) {
  const system = (payload.systemPrompt || settings.systemPrompt || CAH.defaults.DEFAULT_SYSTEM_PROMPT).trim();
  const history = Array.isArray(payload.history) ? payload.history.slice(-8) : [];
  const lines = [];
  for (const m of history) {
    const who = m.role === 'me' ? '我' : '对方';
    lines.push(who + '：' + String(m.text || '').slice(0, 1200));
  }
  if (!history.length || history[history.length - 1].text !== payload.question) {
    lines.push('对方：' + String(payload.question || '').slice(0, 3000));
  }
  const user = lines.join('\n\n').slice(-6000);
  return { system, user };
}

function parseAnswer(text) {
  const raw = String(text || '').trim();
  const ansMatch = raw.match(/答案\s*[:：]\s*([\s\S]*?)(?:\n\s*解析\s*[:：]|$)/);
  const expMatch = raw.match(/解析\s*[:：]\s*([\s\S]*)$/);
  let answer = ansMatch ? ansMatch[1].trim() : '';
  if (!answer) {
    // 没按格式输出：取第一个非空行
    answer = raw.split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
  }
  answer = answer.replace(/^["'“”「」]|["'“”「」]$/g, '').trim();
  return { answer, explanation: expMatch ? expMatch[1].trim() : '' };
}

async function callModel(settings, payload) {
  const url = endpoint(settings);
  const { system, user } = buildMessages(settings, payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);

  let headers;
  let body;
  if (settings.provider === 'anthropic') {
    headers = {
      'content-type': 'application/json',
      'x-api-key': settings.apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    body = {
      model: settings.model,
      max_tokens: Number(settings.maxTokens) || 512,
      temperature: Number(settings.temperature) ?? 0.2,
      system,
      messages: [{ role: 'user', content: user }]
    };
  } else {
    headers = {
      'content-type': 'application/json',
      authorization: 'Bearer ' + settings.apiKey
    };
    body = {
      model: settings.model,
      temperature: Number(settings.temperature) ?? 0.2,
      max_tokens: Number(settings.maxTokens) || 512,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ]
    };
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') return { ok: false, error: '请求超时（60s）' };
    return { ok: false, error: '网络请求失败：' + e.message + '。请检查接口地址、代理与「授权访问接口地址」。' };
  }
  clearTimeout(timer);

  const text = await res.text();
  if (!res.ok) {
    return { ok: false, error: 'HTTP ' + res.status + '：' + text.slice(0, 300) };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: '接口返回不是 JSON：' + text.slice(0, 200) };
  }
  let content = '';
  if (settings.provider === 'anthropic') {
    content = (data.content || []).map((c) => c.text || '').join('');
  } else {
    content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
  }
  if (!content) return { ok: false, error: '接口返回为空：' + JSON.stringify(data).slice(0, 300) };
  const parsed = parseAnswer(content);
  if (!parsed.answer) return { ok: false, error: '未能从模型输出中解析出答案：' + content.slice(0, 200) };
  return { ok: true, answer: parsed.answer, explanation: parsed.explanation, raw: content };
}

async function handleAsk(msg) {
  const settings = await getSettings();
  if (!settings.apiKey) {
    return { ok: false, error: '还没有配置 API Key。请打开扩展设置页填写。' };
  }
  if (!settings.baseUrl) return { ok: false, error: '还没有配置接口地址。' };
  const perm = await ensurePermission(settings.baseUrl);
  if (!perm.ok) return perm;
  return callModel(settings, msg);
}

async function handleTest(msg) {
  const settings = Object.assign({}, DEFAULTS, msg.settings || {});
  if (!settings.apiKey) return { ok: false, error: '请先填写 API Key' };
  const perm = await ensurePermission(settings.baseUrl);
  if (!perm.ok) return perm;
  return callModel(settings, {
    question: '1+1 等于几？请按格式回答。',
    history: [],
    systemPrompt: CAH.defaults.DEFAULT_SYSTEM_PROMPT
  });
}
