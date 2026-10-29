/* 设置默认值。content script、background、options 共用。 */
(function () {
  const CAH = (globalThis.__CAH__ = globalThis.__CAH__ || {});

  const DEFAULTS = {
    // 模型（默认指向当前环境可用的 Anthropic 兼容代理，仅预置地址与模型名，密钥需自填）
    provider: 'anthropic', // openai | anthropic
    baseUrl: 'https://wb.villainy.top',
    apiKey: '',
    model: 'deepseek-v4.1-flash[1M]',
    temperature: 0.2,
    maxTokens: 512,
    systemPrompt: '',

    // 自动化
    autoGenerate: true,
    autoFill: true,
    requireConfirm: true, // 默认发送前确认
    autoAdvance: false, // 默认不自动回「是」
    autoSwitchChapter: true, // 答对但不再加分时，切换到未完成知识点
    advanceText: '是',

    // 节奏
    stabilizeMs: 1200,
    actionDelayMs: 350,
    maxRounds: 100,

    // 手动绑定的选择器
    overrides: {
      messageList: '',
      input: '',
      sendButton: ''
    },

    // 自动登录（凭据只存本机；默认不自动提交）
    loginStudentId: '',
    loginName: '',
    autoLogin: false,
    loginAutoSubmit: false,

    // UI
    panelOpen: true
  };

  function withDefaults(saved) {
    const s = Object.assign({}, DEFAULTS, saved || {});
    s.overrides = Object.assign({}, DEFAULTS.overrides, (saved && saved.overrides) || {});
    return s;
  }

  const PRESETS = [
    {
      id: 'local-proxy',
      label: '当前环境（Anthropic 兼容代理）',
      provider: 'anthropic',
      baseUrl: 'https://wb.villainy.top',
      model: 'deepseek-v4.1-flash[1M]'
    },
    {
      id: 'deepseek',
      label: 'DeepSeek',
      provider: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat'
    },
    {
      id: 'dashscope',
      label: '阿里百炼（通义千问）',
      provider: 'openai',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus'
    },
    {
      id: 'zhipu',
      label: '智谱 GLM',
      provider: 'openai',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4-flash'
    },
    {
      id: 'moonshot',
      label: 'Moonshot',
      provider: 'openai',
      baseUrl: 'https://api.moonshot.cn/v1',
      model: 'moonshot-v1-8k'
    },
    {
      id: 'openai',
      label: 'OpenAI',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini'
    },
    {
      id: 'anthropic',
      label: 'Anthropic Claude',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-5-5'
    },
    {
      id: 'local',
      label: '本地 Ollama / vLLM',
      provider: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5:7b'
    }
  ];

  const DEFAULT_SYSTEM_PROMPT = [
    '你是一个答题助手。用户会给你一段对话记录，最后一条是需要回答的题目。',
    '请直接给出最终答案，要求：',
    '- 单选题给出正确选项的字母和选项内容；',
    '- 多选题把全部正确选项的字母连写，中间不要加顿号、逗号或空格，例如 ABC；',
    '- 填空题按空格顺序给出内容，用「；」分隔；',
    '- 判断题回答「正确」或「错误」；',
    '- 简答题不超过 120 字，直接给结论和要点。',
    '严格按下面两行格式输出，不要输出其它内容：',
    '答案: <可以直接发送给对方的文本>',
    '解析: <不超过 60 字的理由>'
  ].join('\n');

  CAH.defaults = { DEFAULTS, withDefaults, PRESETS, DEFAULT_SYSTEM_PROMPT };
})();
