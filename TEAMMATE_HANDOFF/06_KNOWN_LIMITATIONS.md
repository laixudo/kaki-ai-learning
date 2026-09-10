# 已知限制与禁止误报

1. 云视频尚未用新密钥完成真实云端成功验收：`BLOCKED_BY_SECRET`。
2. 当前 in-app browser 未授予麦克风：`BLOCKED_BY_BROWSER_MEDIA`；文字降级正常。
3. 本地 dry-run 证明媒体组合、Artifact、鉴权读取和页面加载，不等于云端生成。
4. 浏览器自动化确认视频 `readyState=4`、duration=3 和原生 controls，但没有证明自动点击后实际开始播放。
5. 全仓前端 lint 有大量历史 legacy JS 基线问题；改动文件聚焦 lint 为 0。
6. 正式目录不是 Git work tree；本轮没有 commit/push，也没有可供队友直接继续的提交历史。
7. 包内不含用户数据库、上传资料、头像、运行日志、本机生成视频或真实密钥。

在以上 blocker 解除并补齐独立证据前，不得声称 `FINAL ACCEPTED` 或把云视频标记为 PASS。
