继续维护 grey7213/Coze-Agent-Question-Practice-Plugin 仓库，主分支 main。

先读 AGENTS.md、HANDOFF.md、specs/requirements.md、specs/design.md、specs/tasks.md。源码已更新到 #14 chapters；真实 Chrome 曾加载 #13，正常识别真实题目、调用模型并填写 A：大，确认模式未自动发送。

用户已明确本轮“生成并填入真实输入框”就算跑通；资源点不足不属于插件故障。平台恢复前不要再要求用户登录、补额度或追加真实 Coze 请求。章节判断和自动返回/选知识点/开始新题已完成本地 Chrome 扩展回归，最终结果见 output/tests/latest/results.json。

后续智能体修复后再做下一轮真实测试：刷新扩展和页面并核对 #14，保持 requireConfirm=true、autoAdvance=false，验证明确正确且零新增分 → 返回 → 选择其他未完成知识点 → 新题出现 → 生成填写。资源错误、缺失分值、历史反馈、空列表都不能当作封顶或全完成。

本机 Windows PowerShell；exec_command 使用 tty:true。Node 22+、Chrome，无 npm 依赖；本轮 Node 24.9.0。运行 node tests/run-all.js --offline 可复跑七套离线测试。run-live.js 会请求真实模型。受管 Chrome 没有 9222，真实辅助脚本需要另有已存在的 CDP 会话；不要因此关闭用户 Chrome 或重复启动被拒绝的旧方案。

敏感配置只在 tools/env.local.json，禁止打印或复制到交接、测试包、网页可访问资源。修改前保存本地备份；提交和推送按用户授权执行，Author/Committer 使用 grey7213。公开测试汇总在 docs/verification/2026-10-29.json。
