# 包内容与排除项

## 已包含

- FastAPI 后端完整源码、路由、服务、数据库模型与测试。
- React/Vite 前端完整源码、公开资源、锁文件与构建配置。
- AI Workspace、AI Tutor、Living Companion、Inner World、Relax、Voice/Call、Adventure。
- Task16B Cloud Video 内部适配器、Artifact 生命周期和 Video 页面。
- `start.ps1`、`stop.ps1`、`bootstrap.ps1`、`health-check.ps1`、`smoke-test.ps1`。
- `scripts/qa/` 可复用验收脚本。
- `docs/`、`DESIGN.md`、`design-qa.md`。
- `evidence/16B/` 截图、API 摘要、ffprobe、测试和冻结记录。
- `.env.example` 与 `.env.web-takeover.example`。
- 前端 `dist/`，同时保留源码，可重新构建。

## 安全排除

- 根目录真实 `.env`：含本机密钥/密码，不进入包。
- `backend/*.db`、`backend/uploads/`、`backend/data/generated_videos/`：含账号、用户资料或本机验收产物。
- `.venv311/`、`frontend/node_modules/`：体积大且应在接管机重建。
- `.runtime/`、`runtime/`：进程号和运行日志。
- `.pytest_cache/`、`__pycache__/`、`.playwright-cli/`：缓存。
- `.brain-backup/`：历史中间备份，不属于正式运行源码。

排除这些内容不会改变 API 或程序源码。首次启动会按锁文件和 requirements 重新安装依赖，并创建新的本地数据库。
