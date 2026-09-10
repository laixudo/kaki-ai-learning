# G0 discovery

Date: 2026-08-16 (Asia/Shanghai)

## Formal runtime

- Workspace: `C:\Users\wuzbo\KAKI-WINDOWS-FINAL\project`
- Git: the formal directory is not a Git work tree; `git status --short` returns `fatal: not a git repository`.
- Frontend: React 18 + TypeScript + Vite 6; `npm run build`, `npm run dev`, `npm run visual:capture`.
- Backend: FastAPI + SQLAlchemy async + Python 3.11 virtual environment at `.venv311`.
- Startup: `powershell -File .\start.ps1 -NoBrowser`.
- Runtime: frontend `127.0.0.1:5174`, backend `127.0.0.1:8001`; no listener on teammate port 8003.
- Baseline start probes: `/api/notes`, `/api/learning-graphs`, `/api/adventure/current` all returned the expected unauthenticated 401; health returned 200.

## System map

- AI Workspace: `/ai-learning` -> `AiLearningPage` -> `AiWorkspaceKernel` -> accepted `frontend/public/ai-workspace` scripts. Modes are `assistant` and `tutor` in the same shell. The shell owns Conversation Rail, center stage, composer and `MainLayout` impression rail.
- My Learning: `/learning` -> `MyLearningPage`.
- Notes: `/notes` -> `NotesPage`; existing AI Drawer remains part of this page.
- Material: `/resources` -> `ModulePage(kind=resources)`.
- Practice: `/exam` -> `ModulePage(kind=exam)`; real exam generation and answer modal remain.
- Video baseline: `/video` redirected to `/artifacts?type=video`; legacy `/courses/video` rendered `ModulePage(kind=video)` with non-playing poster chrome.
- Companion: `MascotCompanionHost`; sprite registry and persistent drag preference live under `frontend/src/features/mascot`. It dispatches existing Relax, Call/Voice and Inner World flows.
- Artifact: `GeneratedItem` has `user_id`, stable `id`, `type`, `content`, `raw_data`, version pointers and timestamps. `GeneratedItemVersion` stores immutable versions. `/api/items/list`, `/api/items/{id}`, `/api/chat/tasks/artifacts/{id}` and Artifact Shell enforce owner-scoped reads.
- Tutor/Learner facts: workspace tutor routes/services and learner-state service own goals, graph nodes and evaluated evidence. Profile is expression preference only and cannot assert mastery.
- Existing lazy generation: workspace task plan/confirm routes generate lectures, code, mind maps, presentations, exams and legacy video.
- Admin privacy: admin DTO/services project operational metadata; private user content remains governed by admin privacy serializers and existing route checks.
- Browser system: Vite Playwright configuration plus the accepted real-browser harness; this run uses the in-app Chromium at explicit 1920 and 1440 viewports.

## Function map

| UI / Component | Current Route | Handler | API | State | Agent / System Link | Other Entry | Action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| AI Workspace rail/stage/composer | `/ai-learning` | public workspace harness | `/api/chat/*`, `/api/chat/tasks/*` | conversation + mode + task | Workspace agents/Tutor | course/detail/resource | KEEP FUNCTION / STYLE ONLY |
| AI Tutor mode | `/ai-learning` | workspace mode switch | tutor plan and workspace task APIs | same conversation shell | Tutor Orchestrator | learning next action | KEEP FUNCTION / STYLE ONLY |
| My Learning | `/learning` | `MyLearningPage` actions | learning graphs/plans | real plan/node | Learner State | AI Workspace | KEEP FUNCTION / STYLE ONLY |
| Notes list/editor/AI Drawer | `/notes` | `NotesPage` handlers | `/api/notes*` | persistent note/editor | Notes AI | search/result links | KEEP FUNCTION / STYLE ONLY |
| Material list/import | `/resources` | `ModulePage` resource actions | material/upload/import APIs | real processing state | material retrieval | AI Workspace picker | KEEP FUNCTION / STYLE ONLY |
| Practice/exam modal | `/exam` | `ModulePage` exam actions | exam/task/result APIs | real answers/timer/result | evaluator | AI Workspace task | KEEP FUNCTION / STYLE ONLY |
| Video page | `/video` | redirect only at baseline | artifact list + legacy video | no dedicated playback | workspace video | Artifact list | SAFE PRESENTATION RESTRUCTURE |
| Artifact renderer | `/artifacts/:artifactId` | Artifact Shell | owner-bound artifact/version APIs | unified Artifact | workspace agents | history/video page | KEEP FUNCTION / STYLE ONLY |
| Global Header | all student routes | `MainLayout` | search/notifications/auth | real user | shell | all pages | KEEP FUNCTION / STYLE ONLY |
| Living Companion | all student routes | `MascotCompanionHost` | existing companion endpoints/events | persistent position/mode | Relax/Voice/Inner World | global | DO NOT TOUCH |

Unknown behavior is retained by default. No baseline function was deleted during G0.
