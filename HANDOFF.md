# 交接状态（2026-10-29）

## 当前结果

源码和本轮受管 Chrome 均为 **2026-10-29 #18 onboarding**。用户已更换账号并明确授权真实答题，旧交接中的停止真实请求限制已撤销。

真实完成两轮 **10 题，全部正确，累计新增 20 分**。开场确认、题目识别、后台模型、填写、确认发送、实际判分、轮末继续均通过。最终 #18 整体重载后又确认一次“是”，下一题已生成并填入“正确”，停在 ready / 待发送，尚未提交这道第 11 题。

requireConfirm=true、autoAdvance=false。后台已包含 autoSwitchChapter 配置，未再出现章节进度读取失败。正常浏览器的扩展不因源文件变化自动更新，仍需用户在扩展管理页先重新加载扩展，再刷新课程页核对 #18。

## 本轮修复

- 无 data-message-id 的 SDK 欢迎语现在直接读取 onboarding_content 和 prologue；不再选中整个 Page5，把“返回上一页”当末条消息。
- “准备好答题了吗？”和问句形式的继续提示准备“是”；有具体题干/选项时仍优先识别试题。
- 发送检测排除麦克风、上传、清空和停止生成图标；真正发送按钮在填写后重新定位。
- SDK 本人/对方消息按正文和 DOM 角色区分，去掉显示名干扰；本人气泡作为历史边界，慢回复和刷新不再重答自身。
- 发送失败 icon-fail 出现时停止并提示原气泡重试。实测第七次提交曾失败，原气泡只重试一次，随后正确 +2。
- 章节导航在选项回读成功后可衔接欢迎语，恢复正常确认；直接出现目标知识点题目的路径保留。
- 异步取消、发送锁、完整填写校验、轮数上限、跨 iframe 导航恢复等原有约束保留。

## 验证

最终 `node tests/run-all.js --offline`：**209/209，7 套通过**。核心 37、结构 53、噪音 5、iframe 15、登录 12、e2e 22、章节 65。Node 24.9.0、Chrome 156。无需 npm 依赖，测试要求 Node 22+。

- 完整本机结果：output/tests/latest/results.json。
- 公开离线汇总：docs/verification/2026-10-29.json。
- 私有真实结构化记录：output/playwright/live-verification-18.json。
- 最终真实截图：output/playwright/real-confirmed-fill-18.png。
- 两轮完成截图：real-round-complete-15.png、real-two-rounds-complete-17.png，均在 output/playwright/。
- 本地 #18 截图：chapters-confirmed-fill-18.png、chapters-complete-18.png、chapters-iframe-restored-18.png；三张均已检查。公开 docs/images/ 仅复制虚构夹具截图。

真实“正确且零新增分 → 自动返回换章”本轮没有出现，不能宣称通过。章节套件已覆盖零分触发、直接出题、先显示欢迎语、iframe 重建和暂停恢复。曾手动选择 if/switch，但平台继续了未结束的变量题轮次，不能把下拉文字变更当作真实换章成功。

不同快照重复包含历史反馈，不能累加 snapshots.scores。10 题、20 分由两次各含 5 条正确 +2 的轮末记录验证。面板 rounds 包含“是”，扩展重载后可能归零，不等于累计答对题数。

## 浏览器与工具

商店路径 /store/project/7689061576766685203；内容 iframe /ui-builder-app/7689061576766685203/。复用用户已登录的受管 Playwright 浏览器。

扩展 ID：mlgkmnemakafkaelmbphfopcinecdfie。后台路径 src/background.js。整体重新加载扩展后必须刷新页面，不能只刷新内容脚本而留下旧后台。

- 输入框：textarea[placeholder="发送消息"]。
- 真正发送：data-testid="bot-home-chart-send-button"。
- 开场：data-testid="bot.ide.chat_area.onboarding_content"；正文 .chat-uikit-on-boarding__prologue。
- 本人正文：data-testid="chat_area.message.text-input-message-content"。
- 对方正文：data-testid="bot.ide.chat_area.message.text-answer-message-content"。
- 导航：返回上一页、开始答题；下拉 button[role="combobox"]、role="option"。
- 面板宿主 #cah-panel-host 自身尺寸为零，但 Shadow DOM 内固定定位面板可见；等待 attached 或子按钮，不等待宿主 visible。

受管 Chrome 未监听 127.0.0.1:9222，因此 tests/real-session.js 不直接适用；不要为此关闭或重新启动用户的浏览器。通过现有 Playwright 页面和 CDP isolated world 可检查引擎；只返回必要状态，不输出完整历史、存储或身份。

原生窗口操作曾被自动审批因无法确认浏览器 URL 拒绝，已弃用；继续使用当前可用的 Playwright 连接，不重试该原生路径。

## 后续维护

1. 先读 AGENTS.md 和 specs/。最新基线为 #18、209/209，无源码变化时无需反复跑完整测试。
2. 浏览器最后停在变量知识点下一轮第一题，答案“正确”已填入，未发送；继续前先读取当前状态，不重复点上一条发送或重试。
3. 如后续自然出现明确正确且零新增分，再验证真实自动返回、选项回读、目标知识点及新题/开场。缺失分值、资源点不足和空列表都不是封顶。
4. 真实字段变化应先补对应脱敏夹具、复现错误，再修改最小相关代码，更新构建标记及回归结果。
5. 用户已授权将本轮 #18 修复提交并推送到 origin/main；接手时核对本地 HEAD 与远端，后续变更仍按用户授权执行。

Windows PowerShell，exec_command 用 tty:true。常用命令：

    node tests/run-all.js --offline
    node tests/run-chapters.js
    node tests/real-session.js --help

不带 --offline 的 run-all 会额外请求真实模型，页面仍是本地夹具，不等价于真实 Coze 验收。

## 私有文件

密钥、姓名、学号只留 tools/env.local.json，不打印、不进入交接、测试包或网页可访问资源。output/、浏览器会话、真实截图和备份均忽略。

本轮备份：output/backups/20261029-211909-before-startup-fix/，另保留旧离线汇总 verification-2026-10-29-before-18.json。仓库为 grey7213/Coze-Agent-Question-Practice-Plugin，主分支 main；后续提交/推送按用户授权执行，身份遵守 AGENTS.md。
