# 架构与入口

## 运行拓扑

```text
Browser :5174
  -> React/Vite student + admin UI
  -> /api proxy
FastAPI :8001
  -> auth / workspace / tutor / notes / materials / practice / adventure
  -> GeneratedItem + GeneratedItemVersion
  -> internal cloud_video adapter
SQLite by default
```

端口 8003 不属于正式拓扑。

## 主要入口

- `/`：首页
- `/ai-learning`：AI Workspace；Assistant/Tutor 共用 Shell
- `/learning`：我的学习
- `/resources`：资料库
- `/notes`：学习笔记
- `/artifacts`：学习产物
- `/exam`：练习与测评
- `/video`：同一 Artifact 数据源的视频页
- `/profile`：学习画像
- `/admin/login`：管理端

## Cloud Video

- 契约与适配器：`backend/integrations/cloud_video/`
- 持久化编排：`backend/services/video_generation_jobs.py`
- API 接入：`backend/routers/workspace_agents.py`
- 安全投影：`backend/routers/items.py`
- 前端工作区调用：`frontend/public/ai-workspace/scripts/ai-workspace-api.js`
- 状态轮询与重试：`frontend/public/ai-workspace/scripts/ai-workspace-harness.js`
- Video 页面：`frontend/src/pages/VideoPage.tsx`
- 鉴权媒体：`frontend/src/components/AuthenticatedVideo.tsx`

## Artifact 不变量

- 排队时创建唯一 Artifact，之后所有阶段沿用同一 ID。
- 状态：`queued -> generating_script -> generating_audio -> generating_avatar -> composing -> ready|failed`。
- 只有 `ready` 创建不可变版本与媒体 URL。
- 失败重试必须把同一 Artifact 恢复为 `queued`。
- 所有读取按 owner 过滤；其他用户返回 404。
- source context 属于私有输入，不进入公开列表投影。
