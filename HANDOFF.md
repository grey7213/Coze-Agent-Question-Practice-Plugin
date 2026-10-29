# 交接状态（2026-10-29）

## 当前结论

源码构建为 **2026-10-29 #14 chapters**。真实浏览器已加载的是 #13：已识别真实 if/switch 题、经扩展后台调用模型、生成 A：大并准确填入 iframe 输入框，面板与输入框一致，默认确认未自动发送。

用户最新明确：本轮真实页面能正常生成并填写，即视为跑通；资源点不足不属于插件问题。真实判分、完整章节切换和下一章出题等智能体恢复后再测。**不要为本轮继续要求登录、重新加载、解决额度或追加真实 Coze 请求。**

## 本轮实现

- 异步生命周期：暂停、重置、跳过及页面换题使旧生成结果失效；延迟发送取消；发送锁覆盖异步填写；完整答案回读和输入清空校验。
- 章节切换：最新稳定判分明确正确且零新增分才触发；返回上一页 → 展开下拉 → 排除当前/已完成/禁用项 → 回读选择结果 → 开始答题 → 等待目标知识点题目 → 恢复引擎。
- 独立的 autoSwitchChapter 开关默认开启；requireConfirm=true、autoAdvance=false 保持。关闭换章可手动选题继续答题。
- chrome.storage.session 按 tab ID 和 Coze app ID 保存完成集合、实际导航阶段和累计轮数。暂停跨 iframe 仍有效；等待新题阶段恢复不重新返回；全部完成状态可刷新保留。
- 手动绑定在内容 iframe 内拾取，保存 kind 后清理，恢复原 outline；Escape 取消，提示和面板可见性经同标签页总线回流。
- 修正 iframe 夹具配置：三题加三次“是”共 6 次提交，maxRounds 改为 6；严格轮数限制仍有单独回归。

## 验证证据

- 最终七套离线回归 163/163 通过，其中章节与绑定 53/53。汇总：output/tests/latest/results.json；章节用例：chapters-cases.json；生命周期用例：core-cases.json。
- 本轮早先基线七套 97/97，真实模型 6/6；最终章节修改后的整套回归不再调用真实 Coze。
- 真实填写截图：output/playwright/real-confirmed-fill-13.png。
- 显式提交一次后输入清空，Coze 返回“资源点余额不足，请等待额度刷新或升级到专业版”：real-coze-resource-limit.png。这是平台错误，不是判分或章节满分。
- 返回后真实知识点下拉可用 focus + keydown ArrowDown 展开，但列表为“暂无数据”：real-knowledge-empty.png。
- #14 本地扩展截图：chapters-confirmed-fill-14.png、chapters-complete-14.png、chapters-iframe-restored-14.png。均已检查渲染，面板状态和实际输入一致。

## 真实页面接口

- 商店路径：/store/project/7689061576766685203。
- 内容 iframe：/ui-builder-app/7689061576766685203，可能带动态子路径。
- 输入框：textarea[placeholder="发送消息"]。
- 导航按钮文字：返回上一页、开始答题。
- 下拉：button[role="combobox"]、aria-expanded；弹层 role=listbox，选项 role=option。
- 知识点：考查知识点：【Java 基础 - if 判断、switch】。
- 判分：你的答题结果是：正确；本题得分：2；本题考查的知识点：…。

商店侧资源余额与学生得分无关。不能用缺失分值或资源点不足判断封顶。Radix 的合成 click 不一定展开，真实已验证键盘展开，选项 Enter 路径目前在本地夹具通过，待下一轮真实有数据时核对。

## 工具与运行

Windows PowerShell，exec_command 使用 tty:true。Node 24.9.0，测试要求 Node 22+ 和 Chrome，不需要 npm install。

    node tests/run-all.js --offline
    node tests/run-chapters.js
    node tests/real-session.js --help

run-all.js 不带 --offline 会额外调用真实模型，运行本地对话夹具；不是实时 Coze 验收。本轮受管 Chrome 没有 9222 端口，real-session.js 无法连接它。受管 Playwright 可选择现有商店标签页及 ui-builder iframe；页面 console 很吵，只保留结构化短输出，避免打印完整 DOM/历史。

## 下次接手

1. 先读 AGENTS.md 与 specs/，按最新 results.json 确认基线。
2. 平台恢复前，本轮工作已按约定完成，无需重复真实请求。
3. 智能体修复后刷新扩展和页面，先核对 #14；复用已有登录态。
4. 用真实出现的判分和知识点选项验证完整换章；必要时按实际 DOM 补夹具，保留发送前确认。

## 私有文件及备份

密钥、学号、姓名仅使用 tools/env.local.json，不复制到交接文本、测试包或可访问网页资源。源码和文档修改前已备份到 output/backups/20261029-172955-resume/、20261029-181009-before-chapters/、20261029-181836-chapter-integration/。备份为本机私有资料。

用户已授权初始化并推送当前版本，Git 远端为 https://github.com/grey7213/Coze-Agent-Question-Practice-Plugin.git，主分支 main。后续提交与推送按用户授权执行，不关闭全部 Chrome。公开测试汇总在 docs/verification/2026-10-29.json；真实账号截图和备份仍仅在本机保留。
