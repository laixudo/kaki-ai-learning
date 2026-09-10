# 柿子智学队友接管说明

交付版本：2026-08-17 / Task16B + Final Visual

这是可重建、可运行、可继续开发的完整源码包。API 代码与当前本机 API 配置没有因为本次打包而修改。

## 最短接管路径

1. 完整解压压缩包，不要直接在压缩软件中运行。
2. 安装 Windows 10/11、Python 3.11、Node.js 20+、npm、FFmpeg。
3. 在项目根目录复制 `.env.example` 为 `.env`。
4. 只在本机 `.env` 中填入新的有效密钥、强 `SECRET_KEY` 和管理员密码；不要把 `.env` 发回群聊或提交版本库。
5. PowerShell 执行 `Set-ExecutionPolicy -Scope Process Bypass`，再执行 `.\start.ps1`。
6. 浏览器打开 `http://127.0.0.1:5174/`。
7. 执行 `.\health-check.ps1` 与 `.\smoke-test.ps1`。
8. 先阅读 `04_CLOUD_VIDEO_HANDOFF.md` 和 `06_KNOWN_LIMITATIONS.md`，再继续云视频或语音验收。

## 当前交付结论

- 后端测试：290 passed，6 skipped。
- 前端生产构建：PASS。
- 六个目标页面 1920×1080、1440×900 视觉验收：PASS。
- Notes 真实创建/编辑/自动保存/刷新读取：PASS。
- Material 真实上传/解析/刷新读取：PASS。
- Video 本地 dry-run、Artifact、鉴权媒体加载：PASS。
- 云视频：`BLOCKED_BY_SECRET`，没有使用聊天中暴露过的密钥冒充通过。
- 麦克风：`BLOCKED_BY_BROWSER_MEDIA`，文字降级入口可用。

完整验收报告位于 `evidence/16B/FINAL_ACCEPTANCE_REPORT.md`。

## 重要边界

- 不要启动或恢复第二套 Cloud Video 前端、静态头像页、全局视频列表或 8003 服务。
- AI Assistant 与 AI Tutor 必须继续共用同一个 AI Workspace Shell 和同一视频生成服务。
- 视频必须继续进入 owner-bound `GeneratedItem(type=workspace_video)`，不能创建旁路历史记录。
- 不得把 profile 偏好当作 mastery、weakness 或学习证据。
- 不得以 canned fallback 假装模型调用成功。
- 不要把真实 `.env`、数据库、用户上传资料或运行日志重新打包转发。
