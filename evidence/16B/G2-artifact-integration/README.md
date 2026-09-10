# G2 Artifact integration

- One `GeneratedItem(type=workspace_video)` is created at queue time and remains the canonical identity through every stage.
- State contract: `queued -> generating_script -> generating_audio -> generating_avatar -> composing -> ready|failed`.
- Restart reconciliation marks nonterminal jobs `failed/INTERRUPTED_BY_RESTART`; retry transitions that same Artifact back to `queued`.
- Ready items receive the normal immutable Artifact version and authenticated media URL.
- `/api/items/list` exposes the safe public video projection, not private source context.
- Owner A Artifact `56`: initial `queued`, persisted `failed`, error `BLOCKED_BY_SECRET`, retryable `true`.
- Owner B status lookup for Artifact `56`: HTTP 404.
- Unit coverage: `test_video_generation_jobs.py` verifies stable identity, restart persistence, owner isolation and secret-free errors.
