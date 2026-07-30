# AutoSocial Dashboard HTTP API

The dashboard (`npm run dashboard`, default `http://127.0.0.1:3000`) is the control plane. This is
the authoritative endpoint reference, mirrored from `src/dashboard-server.js`.

## Conventions

- **Base URL** = `http://<DASHBOARD_HOST>:<DASHBOARD_PORT>` (default `127.0.0.1:3000`).
- **Same-origin guard.** Every mutating request (`POST`) passes through a guard
  (`src/request-guard.js`). It is allowed when the request's `Origin` (or `Referer`) host matches
  the `Host` header. A request with **no** `Origin`/`Referer`/`Sec-Fetch-Site` is also allowed,
  but the robust move is to always send `Origin: http://127.0.0.1:3000`. Cross-site requests get
  `403 {"ok":false,"error":"Cross-origin dashboard requests are blocked."}`. `GET/HEAD/OPTIONS`
  are never blocked. `scripts/autosocial-cli.mjs` sets the `Origin` header for you.
- **Content type:** send `Content-Type: application/json`; bodies are JSON.
- **Platform routing quirk:** TikTok uses **legacy unprefixed** routes; Instagram and YouTube are
  namespaced. Map an action to a path like:
  - TikTok: `/api/<action>` (e.g. `/api/status`, `/api/run-once`)
  - Instagram: `/api/instagram/<action>`
  - YouTube: `/api/youtube/<action>`

## Platform posting + scheduler endpoints

`<p>` below is `instagram` or `youtube`. For **TikTok**, drop the `/tiktok` segment — use
`/api/status`, `/api/start`, `/api/stop`, `/api/run-once`, `/api/schedule`, `/api/instant-post`,
`/api/schedule-plan`.

| Method | Path | Body | What it does |
| --- | --- | --- | --- |
| GET  | `/api/<p>/status` | — | Full status: `{ running, isPosting, cronExpression, schedulePlan, instantPost, timezone, accountId, queue:{counts:{pending,posted,failed}, pendingVideos:[{name,hasCaption}]}, lastRunAt, lastResult, logs:[{at,level,message}] }` |
| POST | `/api/<p>/run-once` | `{}` | **Publish the next pending video now.** Returns the post result (see below). |
| POST | `/api/<p>/start` | `{}` | Start the scheduler with the saved plan. |
| POST | `/api/<p>/stop` | `{}` | Stop the scheduler. |
| POST | `/api/<p>/schedule` | `{ "expression": "0 */4 * * *" }` | Set a cron schedule (validated). Does **not** auto-start; call `start`. |
| POST | `/api/<p>/schedule-plan` | `{ "type":"daily-times", "times":["09:00","18:30"] }` | Post at fixed local `HH:MM` times. Call `start` after. |
| POST | `/api/<p>/instant-post` | `{ "enabled": true }` | Watch the pending folder and auto-post new files. |

**Post result shape** (`lastResult` / `run-once` response):
- Success: `{ ok:true, movedVideo:"<path in posted/>", movedCaption:"<path|null>" }`
- Empty queue: `{ ok:true, skipped:true, reason:"<platform> queue is empty." }`
- Failure: `{ ok:false, error:"<message>", screenshotPath:"<last-*.png>", movedVideo:"<path in failed/>" }`
- Busy: `{ ok:false, skipped:true, reason:"A <platform> post is already in progress." }`

## Login endpoints (human-in-the-loop)

Opening a login session launches a **visible** Playwright browser on the real site for the **user**
to sign in. The session is saved under `.profiles/<account>/<platform>`. Never enter credentials
programmatically.

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/tiktok/login`, `/api/instagram/login`, `/api/youtube/login` | Open the login browser. |
| GET  | `/api/<p>/login/status` | `{ open, loggedIn?, ... }` — whether a login window is active. |
| POST | `/api/<p>/login/close` | Close the login browser (do this once signed in). |

## Accounts (brands)

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET  | `/api/accounts` | — | `{ accounts:[{id,name}], activeAccountId, activeAccount:{id,name} }` |
| POST | `/api/accounts/add` | `{ "name":"My Brand" }` | Creates account (id is a slug of the name), makes it active, creates its folders. |
| POST | `/api/accounts/select` | `{ "accountId":"my-brand" }` | Switch active account. |

## Setup / health / overview

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| GET  | `/api/setup/health` | — | `{ overall:"ok\|warn\|fail", checks:[...], folders:[...], sessions:[{platform,saved}], nextSteps:[...] }`. Best single call to see what's missing. |
| POST | `/api/setup/open-folder` | `{ "key":"instagramPending" }` | Opens a folder in the OS file manager. Keys: `tiktokPending`, `instagramPending`, `youtubePending`, `uniquifierInput`, `uniquifierOutput`. |
| GET  | `/api/overview` | — | Scheduler + queue status keyed by account id. |

## Settings

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| POST | `/api/settings/save` | `{ "payload": { "DEFAULT_CAPTION":"#brand", "AUTO_ADD_SOUND":"true", "DEFAULT_SOUND_QUERY":"", "RANDOM_QUEUE_ORDER":"false" } }` | Persists to `.env` and applies at runtime. Only these four keys are accepted. |

## Uniquifier (FFmpeg re-encode)

| Method | Path | Body |
| --- | --- | --- |
| GET  | `/api/uniquifier/status` | — |
| POST | `/api/uniquifier/start` | `{ "inputDir":"<path>", "outputDir":"<path>", "logoImage":"<path|empty>" }` (all optional; defaults from `.env`) |
| POST | `/api/uniquifier/stop` | `{}` |
| POST | `/api/uniquifier/open-folder` | `{ "kind":"input"\|"output" }` or `{ "folderPath":"<path>" }` |

## Auto-download (yt-dlp channel watcher → queues)

Requires `autodownload/yt-dlp.exe` (optional dependency).

| Method | Path | Body |
| --- | --- | --- |
| GET  | `/api/autodownload/status` | — |
| POST | `/api/autodownload/start` | `{ "accountId":"<id>" }` (defaults to active) |
| POST | `/api/autodownload/stop` | `{}` |
| POST | `/api/autodownload/configure` | `{ channel, interval, maxVideos, minViews, platforms:["instagram","youtube"], accountId }` |

## Profile download (scrape a TikTok profile to disk, no queueing)

| Method | Path | Body |
| --- | --- | --- |
| GET  | `/api/profile-download/status` | — |
| POST | `/api/profile-download/start` | `{ channel, minViews, maxVideos, scanOnly }` |
| POST | `/api/profile-download/open-folder` | `{}` |

## Minimal call examples

Read-only (no guard concerns):
```bash
curl http://127.0.0.1:3000/api/setup/health
curl http://127.0.0.1:3000/api/instagram/status
```

Mutating (send the Origin header so the guard always allows it):
```bash
curl -X POST http://127.0.0.1:3000/api/instagram/run-once \
  -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:3000" -d '{}'

curl -X POST http://127.0.0.1:3000/api/youtube/schedule \
  -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:3000" \
  -d '{"expression":"0 */4 * * *"}'
```

PowerShell equivalent:
```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:3000/api/instagram/run-once" `
  -Headers @{ Origin = "http://127.0.0.1:3000" } -ContentType "application/json" -Body "{}"
```
