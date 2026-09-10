# 柿子智学自动演示录像

脚本基于项目自带的 Playwright + Chromium，使用 1440×900 桌面视口、自然鼠标轨迹、逐字输入和状态等待生成两条相互独立的连续录像。

## 一键命令

在 `frontend` 目录执行：

```powershell
npm run demo:rehearse          # 两条流程完整彩排，不输出正式视频
npm run demo:full              # 6:30—7:30 完整功能版
npm run demo:highlight         # 55—65 秒亮点版（使用最近一次完整版账号）
npm run demo:record            # 依次正式生成两条视频
```

完整版从全新账号注册开始，完成画像引导、资料上传、AI 讲义与练习、学习产物、资料库、视频学习、笔记、搜索、学习图谱、测评、学习画像、烟花休息和拾光漫游。亮点版不展示登录过程，直接呈现 AI 工作区、真实产物、学习图谱、证据画像和拾光漫游。

正式录像保留 WebM 原始文件，并用 H.264、30fps、`yuv420p`、fast-start 参数转换为 MP4；`ffprobe` 会验证编码、分辨率和时长。报告写入 `output/demo-video/reports/`。
