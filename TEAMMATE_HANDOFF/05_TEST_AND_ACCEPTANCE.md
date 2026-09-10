# 测试与验收

## 后端

```powershell
Set-Location backend
..\.venv311\Scripts\python.exe -m pytest tests -q
```

最新结果：290 passed，6 skipped，8 个 Pydantic V1 validator 弃用警告。

## 前端

```powershell
Set-Location frontend
npm ci
npm run build
npx eslint src/pages/VideoPage.tsx src/components/AuthenticatedVideo.tsx src/routes.ts src/App.tsx
node --check public/ai-workspace/scripts/ai-workspace-api.js
node --check public/ai-workspace/scripts/ai-workspace-harness.js
```

最新结果：生产构建 PASS；聚焦 ESLint 0 问题；两份 legacy JS 语法检查 PASS。

全仓 `npm run lint` 有历史 legacy browser-global 基线问题，不要把它误判为本次 Video 改动回归。

## 启动验收

```powershell
.\health-check.ps1
.\smoke-test.ps1
```

应通过 Backend、Frontend、AI learning、Database、Provider config，以及 Notes/Graph/Adventure 路由和 Adventure 资源检查。

## 浏览器回归

至少检查：

- `/ai-learning` Assistant/Tutor 同 Shell、同 composer、同 Companion。
- Video CTA 可预填 15–20 秒教学视频任务。
- `/learning`、`/notes`、`/resources`、`/exam`、`/video` 均为真实数据状态。
- Notes 保存后刷新不丢失。
- Material 上传后解析为可使用，刷新仍存在。
- Video owner A 可见，owner B 查询同 ID 返回 404。
- Inner World 只显示已保存/grounded 信息。
- Voice 不可用时显示重新授权和文字降级，不虚报 ASR。
- 1920×1080 与 1440×900 无严重 overflow/遮挡。

截图与机器证据位于 `evidence/16B/`。
