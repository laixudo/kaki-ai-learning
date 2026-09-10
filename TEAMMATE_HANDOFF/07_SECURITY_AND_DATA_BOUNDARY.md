# 安全与数据边界

- 真实 `.env` 只留在原机器，不进入压缩包。
- 不要把 API Key、Token、管理员密码、用户资料或原始 prompt 放进截图/Evidence。
- 管理端只使用运营元数据投影，不读取或返回私密用户正文。
- 用户产物、材料、笔记、学习图谱与视频必须按 `user_id`/owner 过滤。
- 路径返回前必须验证位于允许的输出根目录内。
- 鉴权视频由前端先携带 Bearer token 获取 blob，再交给原生 video；不要给外部 URL 注入 token。
- 不要把 profile 表达偏好提升为 mastery/weakness。
- 不要复制本机 `backend/*.db`、`backend/uploads/` 或 `.runtime/` 给其他人。
- 队友接管后应首先轮换聊天中暴露过的密钥。

本包生成过程只读当前 API 与 `.env`；没有修改二者。
