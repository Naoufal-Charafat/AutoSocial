# AutoSocial troubleshooting

Diagnose with data first: `node <skill>/scripts/autosocial-cli.mjs status <platform>` shows the
scheduler state, `lastResult`, and the last ~50 `logs`. `health` shows setup/session gaps. Most
"it didn't post" answers are in those two.

## "Cannot reach the dashboard" / connection refused

The control plane isn't running. Start it in the background from the AutoSocial checkout:
`npm run dashboard`, then `... ping`. If it exits immediately, read its output — a bad
`DASHBOARD_HOST` (non-loopback without `DASHBOARD_ALLOW_REMOTE=true`) makes it refuse to bind.

## A mutating request returns 403 "Cross-origin dashboard requests are blocked"

The same-origin guard rejected it. Send `Origin: http://127.0.0.1:3000` (matching the dashboard
host:port) on every `POST`. The helper script already does this; hand-written curl/fetch must add
it. See `references/http-api.md`.

## "No session found" / a platform won't post because it's not logged in

`health` → `sessions` will show `saved:false` for that platform. Run `login <platform>`, have the
**user** sign in (including 2FA) in the window that opens, confirm with `login:status`, then
`login:close`. The session lives in `.profiles/<account>/<platform>`; if the platform logged the
user out, repeat. Make sure the **active account** is the one you logged in (`accounts`).

## The upload browser opens but never finishes / lands in `failed/`

Expected causes, in order of likelihood:
1. **Platform UI changed** and a selector no longer matches. Open the screenshot at
   `lastResult.screenshotPath` (a `last-*.png` in the checkout) to see where it stalled. This is
   the fragile part of browser automation; the fix is a selector update in the uploader source, not
   a usage change.
2. **Not actually logged in** (session expired) — see above.
3. **Rate limiting / a challenge** (e.g. Instagram 429). Back off, post less frequently, try later.
4. **Slow machine** — raise `POST_DELAY_MS`. Increase `FAILURE_HOLD_MS` to keep the window open
   longer for inspection.

Re-drop the file (it moved to `failed/`) into `pending/` to retry after fixing the cause.

## "Schedule looks saved but nothing posts"

- Schedulers **don't survive a dashboard restart** — after restarting, `start <platform>` again.
- Confirm `status` shows `running:true` and the expected `schedulePlan`.
- Scheduled runs include random jitter (up to ~10 min) — a fire isn't instant.
- `TZ` mismatch: daily times fire in `TZ` from `.env`; if it's `UTC` but the user meant local, they
  fire "at the wrong time." Set `TZ` correctly and re-save the schedule.

## Empty-queue skip

`{ ok:true, skipped:true, reason:"... queue is empty." }` just means nothing was pending. Queue a
video first (`queue <platform> <video> --caption ...`), verify with `pending <platform>`.

## `doctor` fails

- **FFmpeg/ffprobe not found** — install FFmpeg and add it to `PATH` (only the uniquifier/video-info
  need it; posting does not).
- **Playwright Chromium missing** — `npx playwright install chromium`.
- **yt-dlp missing** — only affects auto-download/profile-download. Put `yt-dlp.exe` in
  `autodownload/` or ignore.

## Duplicate-content worries across platforms

Posting the identical file to several platforms can trip duplicate/repost detection. Run the
**uniquifier** (`references/http-api.md` uniquifier endpoints, or CLI `uniquify`) to produce
per-platform variants before queueing.

## Stale debug artifacts

`npm run clean:debug` removes local `last-*.png` / `qa-*.png` screenshots and `.dashboard.*.log`
files. Safe; touches only debug output.
