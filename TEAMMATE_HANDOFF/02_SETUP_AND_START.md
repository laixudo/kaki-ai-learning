# 环境、启动与停止

## 环境

- Windows 10/11
- Python 3.11，`py -3.11` 可用
- Node.js 20+、npm
- FFmpeg 与 ffprobe 在 `PATH`
- 首次安装需要访问 Python/npm 包源

## 配置

```powershell
Copy-Item .env.example .env
```

在 `.env` 中至少配置：

- `MODE=production`
- `SECRET_KEY`：至少 32 位随机值
- `INITIAL_ADMIN_PASSWORD`：强密码
- `LLM_PROVIDER=deepseek`
- 新的 `DEEPSEEK_API_KEY`

云视频还需要新的 `DASHSCOPE_API_KEY`。只有确认旧密钥已撤销、当前值是新密钥后，才可设置 `CLOUD_VIDEO_KEYS_ROTATED=true`。

## 启动

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\start.ps1
```

首次启动会创建 `.venv311`、安装 `backend/requirements.txt`、执行 `npm ci`，然后启动：

- Student：`http://127.0.0.1:5174/`
- Admin：`http://127.0.0.1:5174/admin/login`
- Backend health：`http://127.0.0.1:8001/api/health`

无浏览器启动：

```powershell
.\start.ps1 -NoBrowser
```

停止：

```powershell
.\stop.ps1
```

诊断：

```powershell
.\diagnose.ps1
.\health-check.ps1
.\smoke-test.ps1
```

如果端口 8001 或 5174 被占用，先确认进程归属，再运行 `stop.ps1`；不要结束不属于本项目的进程。
