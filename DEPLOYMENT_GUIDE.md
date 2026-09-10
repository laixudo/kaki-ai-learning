# 柿子智学部署与交接指南

版本日期：2026-08-17  
适用平台：Windows 10 / Windows 11  
项目结构：React + Vite 前端、FastAPI 后端、SQLite 默认数据库

## 1. 交付包说明

交付 ZIP 解压后应包含以下关键内容：

- `backend/`：FastAPI 后端、数据库模型、智能体与测试。
- `frontend/`：React 前端、静态资源、`package-lock.json`。
- `docs/`：产品与技术说明。
- `TEAMMATE_HANDOFF/`：既有架构、验收、边界与交接资料。
- `takeover_tools/`：安全、完整性与接管辅助脚本。
- `start.ps1`、`stop.ps1`：一键启动和停止。
- `health-check.ps1`、`smoke-test.ps1`、`diagnose.ps1`：部署验证与诊断。
- `.env.example`：环境变量模板，不包含真实密钥。
- `SHA256SUMS.txt`：交付包内部文件哈希清单。

交付包不会包含以下本机或敏感内容：

- `.env`、真实 API Key、管理员真实密码。
- `backend/*.db`、数据库 WAL/SHM 文件和用户业务数据。
- 用户上传文件、头像、生成视频和运行日志。
- `.venv311/`、`node_modules/`、缓存和 `__pycache__/`。

## 2. 部署模式边界

当前工程的正式启动脚本将前端和后端绑定到本机回环地址：

- 学生端：`http://127.0.0.1:5174/`
- 管理端：`http://127.0.0.1:5174/admin/login`
- 后端健康接口：`http://127.0.0.1:8001/api/health`

该方式适合本机演示、开发验收和单机部署。不要直接把 Vite 开发服务器或 Uvicorn 裸端口暴露到公网。公网或局域网多人部署需要另行配置生产前端构建、反向代理、TLS、正式数据库、备份和进程守护。

## 3. 环境准备

目标机器需要安装：

1. Windows 10 或 Windows 11。
2. Python 3.11，并确保 `py -3.11` 可用。
3. Node.js 20 或更高版本，并确保 `node`、`npm` 可用。
4. FFmpeg 与 ffprobe，并加入系统 `PATH`。
5. 可访问 Python、npm 和所选 AI Provider 的网络。

检查命令：

```powershell
py -3.11 --version
node --version
npm --version
ffmpeg -version
ffprobe -version
```

## 4. 解压与完整性检查

把 ZIP 完整解压到不含特殊符号、路径不过长的目录，例如：

```text
D:\apps\KAKI-WINDOWS-FINAL
```

不要直接在压缩软件预览窗口中运行脚本。

ZIP 外部会同时提供一个 `.sha256` 文件。可在 PowerShell 中核对：

```powershell
Get-FileHash .\KAKI-WINDOWS-DEPLOY-20260817.zip -Algorithm SHA256
Get-Content .\KAKI-WINDOWS-DEPLOY-20260817.zip.sha256
```

两个哈希值应完全一致。

## 5. 创建本机配置

进入解压后的项目根目录：

```powershell
Set-Location D:\apps\KAKI-WINDOWS-FINAL
Copy-Item .env.example .env
```

编辑 `.env`，至少替换以下值：

```dotenv
MODE=production
DEBUG=false
LLM_PROVIDER=deepseek
LLM_MODEL=deepseek-chat
DEEPSEEK_API_KEY=替换为新申请的有效密钥
SECRET_KEY=替换为至少32位的强随机字符串
INITIAL_ADMIN_USERNAME=admin
INITIAL_ADMIN_PASSWORD=替换为强管理员密码
```

生成随机 `SECRET_KEY` 的一种方式：

```powershell
$bytes = New-Object byte[] 48
[System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
[Convert]::ToBase64String($bytes)
```

注意：

- `.env` 只保存在部署机器，不要发送到聊天、邮件或提交代码仓库。
- 不要复用曾经公开或发到群聊中的密钥。
- 云视频需要额外配置新的 `DASHSCOPE_API_KEY`。
- 只有确认视频密钥已轮换后，才可设置 `CLOUD_VIDEO_KEYS_ROTATED=true`。

## 6. 首次启动

在项目根目录打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start.ps1
```

不自动打开浏览器：

```powershell
.\start.ps1 -NoBrowser
```

首次启动会：

1. 创建 `.venv311` Python 虚拟环境。
2. 安装 `backend/requirements.txt`。
3. 在缺少 `frontend/node_modules` 时执行 `npm ci`。
4. 初始化默认 SQLite 数据库。
5. 启动 FastAPI 后端与 Vite 前端。
6. 检查 Notes、Learning Graph 和 Adventure 核心路由。

首次安装耗时取决于网络和依赖缓存。不要在安装过程中关闭终端。

## 7. 部署验收

启动完成后依次运行：

```powershell
.\health-check.ps1
.\smoke-test.ps1
```

预期结果：

- Backend、Frontend、AI learning page、Database、Provider config 均为 `PASS`。
- Notes、Learning Graph、Adventure 路由存在。
- Adventure 清单、场景和角色资源返回 200。

随后在浏览器完成最小人工验收：

1. 注册一个测试账号并完成或跳过画像引导。
2. 登录后向 AI 学习发送一个简单问题，确认收到真实回复。
3. 打开“我的学习、资料库、学习笔记、学习产物、视频学习、练习与测评、个人中心”。
4. 创建一篇测试笔记，等待保存后刷新，确认内容仍存在。
5. 管理员登录管理端，确认仪表盘、用户、任务和系统信息可加载。

## 8. 日常启停

启动：

```powershell
.\start.ps1 -NoBrowser
```

停止：

```powershell
.\stop.ps1
```

不要只启动 `frontend`，否则前端虽然能打开，但登录请求会因为无法连接 `127.0.0.1:8001` 而失败。

运行日志位于 `.runtime/`，仅用于部署机器本地排查，不要重新打包转发。

## 9. 常见故障排查

### 页面能打开，但登录返回 500

先访问：

```text
http://127.0.0.1:8001/api/health
```

如果无法连接，说明后端未启动。运行：

```powershell
.\stop.ps1
.\start.ps1 -NoBrowser
Get-Content .\.runtime\backend.err.log -Tail 100
```

### 端口被占用

检查端口：

```powershell
Get-NetTCPConnection -State Listen -LocalPort 5174,8001
```

先确认进程归属，再停止旧实例。不要结束不属于本项目的进程。

### AI 页面正常，但模型不回复

检查 `.env` 中：

- `MODE=production`
- Provider 名称与模型名称正确。
- Provider API Key 有效且未过期。
- 部署机器可以访问 Provider 网络。

然后运行：

```powershell
.\health-check.ps1
Get-Content .\.runtime\backend.err.log -Tail 150
```

### 视频生成失败

确认：

```powershell
ffmpeg -version
ffprobe -version
```

本地视频降级能力依赖 FFmpeg。云视频还需要有效的 DashScope 密钥及正确的密钥轮换标记。

### 麦克风或语音不可用

确认浏览器已授予麦克风权限，并优先使用最新版 Chrome 或 Edge。无法授权时可使用文字输入降级入口。

## 10. 数据、备份与安全

默认 SQLite 数据库位于后端工作目录，生产数据必须由部署负责人定期备份。备份前先停止服务，避免复制到不一致状态。

建议至少备份：

- 正式数据库。
- 正式用户上传目录。
- 本机 `.env` 的安全副本。

备份不得放进源码交付 ZIP。恢复前应验证目标路径和备份时间，禁止用不明来源数据库覆盖正式数据。

安全要求：

- 立即替换示例管理员密码和 `SECRET_KEY`。
- 不把 5174、8001 直接暴露到公网。
- 公网部署必须启用 HTTPS、反向代理、访问控制和日志轮转。
- 定期轮换 AI Provider 密钥。
- 不把用户数据库、上传资料、头像、生成视频或日志发送给无权限人员。

## 11. 更新与回滚

更新前：

1. 停止服务。
2. 备份数据库、上传目录和 `.env`。
3. 保留旧版本完整目录。

更新时使用新的完整交付目录，不要直接覆盖旧目录中的 `.env` 和正式数据库。复制必要的本机配置与数据后重新启动并执行健康检查。

回滚时停止新版本，恢复旧目录及与其匹配的数据库备份，再执行：

```powershell
.\start.ps1 -NoBrowser
.\health-check.ps1
.\smoke-test.ps1
```

## 12. 交接确认清单

- [ ] ZIP SHA-256 已核对。
- [ ] Python、Node.js、npm、FFmpeg 已安装。
- [ ] `.env` 已从模板创建，所有示例值均已替换。
- [ ] 管理员密码和 `SECRET_KEY` 为部署方新生成值。
- [ ] `health-check.ps1` 全部通过。
- [ ] `smoke-test.ps1` 全部通过。
- [ ] 学生登录和真实 AI 对话通过。
- [ ] 管理端登录和仪表盘通过。
- [ ] 数据备份位置、负责人和恢复流程已确认。
- [ ] 公网场景已配置反向代理、HTTPS 和进程守护。

