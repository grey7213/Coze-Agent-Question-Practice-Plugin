# Coze 答题助手

Chrome MV3 扩展：在 Coze 智能体页面识别题目，经后台调用用户配置的模型，填写答案。默认 `requireConfirm=true`、`autoAdvance=false`。智能体的学号姓名填写可自动化；火山引擎手机号和验证码登录由用户操作。

## 导航

- 先读 `HANDOFF.md`、`specs/requirements.md`、`specs/design.md`、`specs/tasks.md`。
- `src/core/detect.js`：DOM 定位；`engine.js`：消息分类和答题状态机；`chapters.js`：判分、知识点导航及恢复。
- `src/content/main.js`、`bus.js`、`panel.js`：跨 frame 命令及浮动面板。
- `src/background.js`：模型请求、权限检查、按 tab/app 隔离的 session 进度；`src/options/`：设置页。
- `src/shared/build.js`：每次源码修改后更新标记，刷新扩展和真实页面后核对。
- `tests/`：Node + Chrome CDP 集成测试；无需 npm 依赖，Node 22+（使用全局 WebSocket）。

## 验证

优先运行 `node tests/run-all.js --offline`：核心、结构、噪音、iframe、登录、e2e、章节共七套 Chrome 回归。章节可单独运行 `node tests/run-chapters.js`。不带 `--offline` 额外运行 `run-live.js`，会使用已配置的真实模型额度。结果写入 `output/tests/latest/`。

真实辅助命令见 `node tests/real-session.js --help`，仅适用于已有 Chrome 独立调试会话监听 `127.0.0.1:9222`。本轮受管 Chrome 无此端口，不要因此重启或关闭用户现有 Chrome。

不要仅凭测试数量宣称真实页面通过；必须核对真实题目、填入内容、确认模式及实际页面截图。测试中的成绩、姓名、学号必须是虚构值。

2026-10-29 用户已明确本轮真实验收以“生成并填入真实输入框”为终点，这部分 #13 已通过；当前源码 #14 的章节闭环在本地验证，真实判分/下一章出题等智能体恢复后再测。不要继续请求真实 Coze 或要求用户处理额度。

章节规则：明确正确且零新增分才切换，缺失分值不是 0，商店资源点不是学生得分。保存导航阶段后才能点返回/开始；暂停保留阶段但取消自动恢复。空下拉是错误，不能当全部完成。默认确认、轮数上限及跨章节累计数必须保留。

## 本地文件

- 密钥、学号、姓名仅放忽略的 `tools/env.local.json`。不打印这些值，不加入可被网页访问的扩展资源。
- `output/` 保存本地截图、日志与改动前备份，禁止复制到测试扩展或提交。
- Git 远端为 `https://github.com/grey7213/Coze-Agent-Question-Practice-Plugin.git`，主分支 `main`。修改已有文件前保存必要的本地备份，提交和推送按用户授权执行。
- 新提交 Author 和 Committer 均使用 `grey7213 <134256592+grey7213@users.noreply.github.com>`，提交前用 `git var` 核对；不附加代理署名。
- `.playwright-cli/`、`output/`、真实本地配置和 `specs/*.png` 不提交。公开演示仅使用已核对的虚构数据截图，放入 `docs/images/`；脱敏测试汇总放入 `docs/verification/`。

## 已验证的踩坑

- Symptom: `real-flow.js probe` 长时间无退出，CDP 查询却正常。
  Cause: Chrome 调试窗口被最小化，`Page.captureScreenshot` 一直等待；旧脚本没有命令超时。
  Fix: 恢复这个调试窗口后截图可返回；诊断脚本需有超时和截图失败提示。
  Verify: 2026-10-28，恢复窗口后原 `node tests/real-flow.js probe` 在约 5 秒内完成。

- Symptom: 暂停或换题后旧模型结果仍回写，填写期间连点可能重复发送。
  Cause: 异步结果未绑定动作版本、题目及输入框，发送锁取得太晚，回读只比较答案前缀。
  Fix: 引擎统一动作版本与上下文校验，发送前取得锁，完整比较答案，发送后确认输入清空。
  Verify: `tests/lifecycle-cases.js` 曾复现 14 项失败；修复后核心套件 37/37。

- Symptom: 收紧最大轮数后 iframe 三题测试无法结束。
  Cause: 夹具要求三题加三次“是”，共 6 次提交，却设置 maxRounds=5。
  Fix: 夹具设置为 6，保留生产限制及严格上限回归。
  Verify: `node tests/run-iframe.js`，15/15。

- Symptom: 手动绑定无法点到 iframe 内元素，结束时报 picking.kind 为空，子 frame 提示不显示。
  Cause: 遮罩建在顶层，stopPick 清空对象后仍读取 kind，frame-toast 未经后台转发。
  Fix: 绑定命令下发内容 frame，先保留 kind 再清理，提示经 tab 内总线回流，恢复面板及原 outline。
  Verify: `node tests/run-chapters.js` 覆盖真实鼠标点选、Escape 取消、提示回流及绑定后生成填写。

- Symptom: 新章节测试在复制文件阶段无输出退出，退出码 -1073740791。
  Cause: 本机 Node 24.9.0 调用 fs.cpSync 递归复制 src 时可复现原生崩溃；底层原因尚未定位。
  Fix: 沿用现有测试的 readdirSync + copyFileSync 递归复制，仅复制 src 与 manifest，不复制真实配置。
  Verify: 单独复制复现后替换调用，`node tests/run-chapters.js` 正常完成。

- Symptom: GitHub CLI 返回 EOF，Git HTTPS 返回 SSL_ERROR_SYSCALL。
  Cause: 2026-10-29 本机 127.0.0.1:7897 代理链路连接 GitHub 失败，直接访问 API 返回 200。
  Fix: 确认直连可用后，仅为当前命令设置 NO_PROXY=github.com,api.github.com，并给 Git 传入 `-c http.proxy=`；不关闭 TLS 校验，不修改全局代理。
  Verify: `gh api user --jq .login` 返回 grey7213，仓库元数据与 `git ls-remote` 正常读取。
