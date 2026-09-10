# G7 final regression

Date: 2026-08-16 (Asia/Shanghai)

## Golden-path matrix

| ID | Result | Current-turn evidence |
| --- | --- | --- |
| R01 AI Workspace | PASS | Assistant shell, conversation rail, composer, tool entry, resource state and Video CTA prefill were exercised in the authenticated browser. |
| R02 AI Tutor | PASS locally / `BLOCKED_BY_SECRET` externally | Tutor switches inside the same shell and retains the same composer/tools/companion. A live external inference call was not made with exposed credentials. |
| R03 My Learning | PASS | Authenticated route, real empty state and available actions loaded; backend learning-plan/graph coverage is included in the full suite. |
| R04 Notes | PASS | Real create, title/body edit, autosave, route reload and persisted read all passed. |
| R05 Material | PASS | Synthetic TXT upload parsed to `ready`, appeared in the owner list and remained visible on fresh UI load. |
| R06 Practice | PASS locally / `BLOCKED_BY_SECRET` for fresh AI generation | Authenticated practice surface, no-plan state and exam APIs passed regression; no exposed key was used to create fresh provider content. |
| R07 Video | PASS locally / `BLOCKED_BY_SECRET` for cloud generation | Same Artifact lifecycle, local dry-run media, authenticated blob load, retry state and Video page passed. Cloud status remains honest. |
| R08 Living Companion | PASS | Companion appears once; Relax overlay and Call entry opened from the existing host. |
| R09 Inner World | PASS | Existing modal opened and showed only saved/profile-derived facts plus empty-state language. |
| R10 Adventure | PASS | Adventure API route existence, manifest, world-map scene and mascot resources passed startup smoke; service coverage passed in the backend suite. |
| R11 Voice | `BLOCKED_BY_BROWSER_MEDIA` | Continuous-call panel opened and kept reauthorize plus text fallback. The in-app browser did not grant microphone capture, so no audio success claim is made. |
| R12 Artifact integrity | PASS | Stable ID, persisted stages, immutable ready version, owner isolation, retry and authenticated media all passed. |

External blockers are isolated capability states, not fabricated PASS results. The UI remains usable through text/local paths.

## Security and isolation

- Synthetic owner A Artifact 56 persisted `failed/BLOCKED_BY_SECRET`; synthetic owner B received HTTP 404 for the same ID.
- Admin operational endpoints returned only projected metadata; checked responses contained no `password_hash`, raw prompt or API-key fields.
- Startup reconciliation and a cold reload preserved the ready local Artifact.
- Secret-literal scans found no credential-shaped values in evidence, docs or QA scripts and no long credential literal in owned source surfaces. The project `.env` was intentionally excluded from printed output.

## Browser and layout

- Authenticated fresh-tab route sweep: `/ai-learning`, `/learning`, `/notes`, `/resources`, `/exam`, `/video`.
- Fresh browser-console errors across the six-route sweep: 0.
- 1920x1080 and 1440x900 screenshots were captured for all six target surfaces.
- Measured horizontal overflow: none. Scrollbar-bearing routes reported document width equal to client width; fixed-height routes matched viewport width.
- Video media element loaded the protected blob with `readyState=4`, duration 3 seconds and native controls. Automated native-control clicking did not prove audible/visible playback, so evidence is limited to successful decode/load readiness.

## Commands and results

```text
frontend> npm run build
PASS: TypeScript and Vite production build; 3155 modules transformed.

frontend> npx eslint src/pages/VideoPage.tsx src/components/AuthenticatedVideo.tsx src/routes.ts src/App.tsx
PASS: 0 errors, 0 warnings.

backend> ..\.venv311\Scripts\python.exe -m pytest tests -q
PASS: 290 passed, 6 skipped, 8 pre-existing Pydantic deprecation warnings in 33.45s.

project> .\health-check.ps1
PASS: backend, frontend, AI page, database and provider configuration.

project> .\smoke-test.ps1
PASS: notes/graphs/adventure protected routes, frontend, AI page and adventure resources.
```

The repository-wide frontend lint baseline remains outside this change surface: an earlier full run reported 1,649 issues, primarily browser globals in preserved legacy public scripts. Modified legacy scripts separately passed `node --check`, and the changed TypeScript files passed focused ESLint.
