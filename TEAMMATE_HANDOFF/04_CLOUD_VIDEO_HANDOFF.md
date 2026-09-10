# Cloud Video 接管

## 已完成

- 队友模块的 provider/pipeline 思路已移入内部 `cloud_video` 边界。
- Script 使用 KAKI 现有 LLM 服务和结构化输出，无 canned fallback。
- StyleContext 与 EvidenceTeachingContext 分离；只有受信学习证据可进入 weakness/next action。
- 使用正式柿小吉形象，不使用人类示例头像替代。
- S2V、TTS、FFmpeg 合成、ffprobe、Artifact 状态、重试、冷启动恢复均已有覆盖。
- `/video` 与 AI Workspace 读取同一 owner-bound Artifact。

## 当前 blocker

`BLOCKED_BY_SECRET`

此前出现在聊天中的密钥视为已暴露。本交付包不会包含它们，也没有使用它们生成云端 PASS。

解除顺序：

1. 在供应商控制台撤销暴露过的 DeepSeek、DashScope 密钥。
2. 创建新密钥。
3. 仅写入接管机本地 `.env`。
4. 设置 `CLOUD_VIDEO_KEYS_ROTATED=true`。
5. 启动服务，读取认证后的 `/api/chat/tasks/video/health`。
6. 从 AI Workspace 发起一条 15–20 秒教学视频任务。
7. 记录同一 Artifact 从 queued 到 ready 的完整状态。
8. 在 `/video` 与 Artifact Shell 播放，并保存脱敏 Evidence。

不得通过直接改数据库、伪造 ready、把 dry-run 改名为 cloud，或添加静态 fallback 来解除 blocker。

## 模型标识

- LLM：`deepseek-chat`
- Provider：`s2v`
- Avatar model：`wan2.2-s2v`
- Detection model：`wan2.2-s2v-detect`

配置变量见 `.env.example`；本次打包没有改动真实 API 配置。
