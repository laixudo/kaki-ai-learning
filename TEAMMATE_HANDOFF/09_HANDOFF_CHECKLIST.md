# 队友接管清单

## 收包

- [ ] ZIP SHA256 与发送方提供值一致
- [ ] 完整解压，无损坏/路径截断
- [ ] 已阅读 `00_READ_ME_FIRST.md`
- [ ] 确认包内不存在真实 `.env`、数据库和用户上传内容

## 本地启动

- [ ] Python 3.11、Node 20+、npm、FFmpeg 可用
- [ ] 从 `.env.example` 新建本机 `.env`
- [ ] 使用新密钥和强密码
- [ ] `.\start.ps1` 成功
- [ ] `.\health-check.ps1` 通过
- [ ] `.\smoke-test.ps1` 通过

## 回归

- [ ] 后端 290 tests 通过或对差异有记录
- [ ] 前端 build 通过
- [ ] AI Assistant/Tutor 同 Shell
- [ ] Notes 持久化
- [ ] Material 上传解析
- [ ] Video 同 Artifact 状态/重试/播放
- [ ] 两用户隔离 404
- [ ] Admin Privacy
- [ ] Companion/Relax/Inner World/Voice 降级
- [ ] 1920 与 1440 页面检查

## 云视频

- [ ] 旧密钥已撤销
- [ ] 新密钥只写入本机 `.env`
- [ ] `CLOUD_VIDEO_KEYS_ROTATED=true`
- [ ] 真实 queued-to-ready 证据
- [ ] ffprobe、output SHA、播放截图
- [ ] 未使用 dry-run 冒充云生成

## 交付纪律

- [ ] 不引入第二套前端或 8003 服务
- [ ] 不绕过 owner-bound Artifact
- [ ] 不泄露 API Key/用户数据
- [ ] 不虚报 ASR、云生成或 mastery
- [ ] 所有新 blocker 写入 Evidence
