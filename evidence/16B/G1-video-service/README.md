# G1 Cloud Video service

## Integrated

- Source archive SHA256: `A7E386CC577AA94B1B6FFF6BE478E07E627EE7E43C914813B8FED588455B0FCC`.
- Ported the provider detection/generation ideas into the internal `backend/integrations/cloud_video` boundary.
- Reused KAKI's existing LLM service for structured scripts; there is no canned fallback script.
- Added StyleContext and EvidenceTeachingContext as separate strict contracts. Profile fields cannot populate mastery or weakness evidence.
- Uses the accepted `shixiaoji-official.jpg`; no human sample substitution.
- Exposes no teammate UI, no static avatar page, no global video list and no port 8003.

## Credential result

Cloud status is `BLOCKED_BY_SECRET`. Credentials pasted into chat were treated as exposed and were not copied into source/evidence or used for a cloud PASS. `CLOUD_VIDEO_KEYS_ROTATED=false` remains the safe default. The authenticated health endpoint returns booleans, model identifiers and blocker code only.

Local dry-run is a separate PASS for media composition only. It is labelled `dry_run=true` and cannot be represented as cloud generation.

## Evidence

- `ffprobe.json`: H.264 1280x720 + AAC mono, 3 seconds.
- `dry-run-output.sha256`: local evidence output digest.
- `cloud-health.json`: redacted capability projection.
- Playback screenshot: `../G6-video/video-ready-dry-run-1920.png`.
