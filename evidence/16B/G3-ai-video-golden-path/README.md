# G3 AI Video golden path

- Video page CTA routes into the existing AI Workspace and prefills a 15-20 second KAKI teaching-video request.
- Both Learning Assistant and AI Tutor share the same workspace shell, task endpoint and `workspace_video` lifecycle.
- The workspace API starts the task asynchronously, polls persisted stages, opens authenticated media, and renders a same-Artifact retry action on failure.
- `/video` reads `/api/items/list?type=workspace_video`, opens `/artifacts/{id}`, and never creates a second history record.
- Cloud execution stops honestly at `BLOCKED_BY_SECRET`; local dry-run demonstrates the remainder of Artifact and playback behavior.
- Browser evidence: `../G5-ai-workspace/ai-tutor-same-shell-1920.png`, `../G6-video/video-failed-blocker-1920.png`, `../G6-video/video-ready-dry-run-1920.png`.
