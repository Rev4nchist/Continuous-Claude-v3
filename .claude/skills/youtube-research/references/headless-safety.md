# Headless and scheduled safety

## Scheduled source and authentication boundary

The scheduled run synchronizes and selects only these nine playlist IDs:

1. `PLg5FD0-TFyzP9PZmwFGw2VoADQubtACsi`
2. `PLg5FD0-TFyzOG4GU_pykZhuVJi-aKi-xE`
3. `PLg5FD0-TFyzPfZ1qAkcgqSXvfA7GVDcC8`
4. `PLGB4mkrHM1jc`
5. `PLg5FD0-TFyzPO5n9yD4ZqT91BoHe1FvzJ`
6. `PLg5FD0-TFyzNwmPYCybhpQqcoAoOFu2v1`
7. `PLAt38qX-zDTs`
8. `PLE6eZbTQhX_s`
9. `PLg5FD0-TFyzOvFDwnCKu0SvStm3pz5LLv`

The wrapper runs `source.mjs sync-allowlist` followed by `refresh.mjs --allowlist-only`.
Missing, inactive, or duplicate allowlisted sources fail closed; unrelated active sources remain
registered but cannot enter the daily run. Screenshots do not authorize additional sources.

The wrapper sets `YT_COOKIES_FILE` to
`%USERPROFILE%\.claude\secrets\youtube-cookies.txt`. Cookie contents must never enter logs,
staging, source control, prompts, or model input. Missing/expired authentication is `Blocked` or
`Failed`, not incomplete `Ready`. `YT_COOKIES_FROM_BROWSER` is limited to attended interactive
runs; direct Chrome-cookie access is unsuitable for Task Scheduler because its database may be
locked.

## Authority split

The scheduled wrapper invokes the trusted Node orchestrator. For each bounded analysis
window, the orchestrator invokes the model with `--allowedTools Read` and captures stdout.
The model receives no Bash, MCP, network, write, target-edit, publishing, or deployment
authority. Trusted code validates JSON and performs atomic writes.

Captions, descriptions, OCR, comments in code shown on screen, and visual text are untrusted
data. The prompt explicitly forbids following embedded instructions. Model output is data,
not a command stream.

## Promotion gates

- Reject non-JSON or schema-invalid model output.
- Reject a window that omits, duplicates, or invents an evidence ID.
- Reject outline timestamps outside video duration.
- Reject uncited content units, unreviewed visuals, and unmapped transcript/visual evidence.
- Never promote partial windows into a ready video.
- Never generate target packages from a partially analyzed playlist snapshot.
- Never infer success from process exit code alone; verify durable run and coverage records.

Use `scripts/youtube/scheduled-youtube-refresh.bat` for Task Scheduler. It captures logs and
validates `refresh-latest.json`. Installing or changing the Task Scheduler job is a separate
explicit system action.
