---
name: autosocial
description: >-
  Orchestrate AutoSocial Studio — the local multi-account dashboard that publishes short-form
  video to Instagram, YouTube, and TikTok via saved browser sessions — to queue content, publish
  now, schedule posts, manage brand accounts, check login/queue status, and run the auto-download
  and video-uniquifier subsystems. Use this skill WHENEVER the user wants to post / publish /
  upload / schedule a Reel, Short, or TikTok, drop a video into a posting queue, set up daily or
  cron posting, check what's queued or why an upload failed, log a brand into a platform, or asks
  you to "act as the orchestrator of my social media" — even if they don't name AutoSocial. It
  drives AutoSocial's local HTTP control plane; it does not call official platform APIs and never
  enters the user's credentials.
---

# AutoSocial Orchestrator

AutoSocial Studio is a **local** creator-ops dashboard (Node + Express + Playwright) that posts
short-form video to **TikTok, Instagram, and YouTube** by driving real browser sessions the user
logged in themselves. Your job with this skill is to be the **orchestrator**: prepare content,
manage queues and accounts, and run publishing on the user's behalf through AutoSocial's local
control plane — while leaving two things firmly to the human: **signing in** and **approving each
public post**.

There is no hosted service and no official-API posting here. Everything is a local process on the
user's machine talking to `http://127.0.0.1:3000`.

## The mental model (read this first)

- **Control plane = the dashboard HTTP API.** Starting `npm run dashboard` boots an Express server
  that exposes the whole system as REST endpoints. Instagram and YouTube are *only* controllable
  through this API (the CLI covers TikTok only). So the dashboard must be running for you to
  orchestrate IG/YT. Full endpoint list: `references/http-api.md`.
- **Content = files in a queue folder.** Publishing is not "send this bytes to an API." It is:
  put a video in `queue/<account>/<platform>/pending/`, optionally with a caption sidecar, then
  tell that platform's scheduler to post the next pending item. On success the file moves to
  `posted/`; on failure to `failed/` with a diagnostic screenshot.
- **Publishing = a real browser upload.** A `run-once` spawns a Playwright Chromium that navigates
  the real upload page and clicks through it using the saved session. By default it is **visible**
  (`HEADLESS=false`) so the user can watch and intervene. It is slow (tens of seconds) and can
  break if the platform UI changed — that is expected, not a bug in your usage.
- **One helper wraps all of it.** `scripts/autosocial-cli.mjs` speaks the API (with the right
  same-origin header) and manages the queue. Prefer it over hand-writing curl/fetch. Run
  `node <skill>/scripts/autosocial-cli.mjs help` for the command surface.

## Two rules you must not break

1. **Never enter the user's platform credentials, and never solve a login/CAPTCHA for them.**
   Signing in is a human action. You *trigger* the login browser (`login <platform>`), then hand
   off: the user types their password and 2FA in the window that opened. You only confirm the
   session was saved and close the window. This matches both platform terms and the basic safety
   rule about credentials.
2. **Treat every publish as publishing public content — get explicit approval first.** `publish`,
   `post`, `instant on`, `start`, and the `schedule*` commands all cause real posts to real
   audiences. Before running any of them, tell the user exactly what will go out (platform,
   account, which video, the caption) and wait for a clear yes. A cron/daily schedule is a
   standing authorization to post repeatedly — confirm the cadence, don't just set it. When in
   doubt, prefer a single `run-once` the user approved over enabling autopilot.

These aren't bureaucracy — they're the two places where being wrong is expensive (a locked account,
an unwanted public post). Everything else you can drive freely.

## Setup: get to a working dashboard

Run this once per machine / checkout. Detailed commands and config live in
`references/cli-and-config.md`; the short path:

1. **Dependencies** (from the AutoSocial checkout, e.g. `D:\Mis-Proyecto\AutoSocial`):
   `npm ci` then `npx playwright install chromium`. FFmpeg + ffprobe must be on `PATH` (only the
   uniquifier needs them). `npm run doctor` verifies everything and should end with "Doctor checks
   passed."
2. **Config:** if `.env` is missing, copy `.env.example` to `.env`. Sensible defaults work; set
   `TZ` to the user's timezone so schedules fire at the right local time, and `DEFAULT_CAPTION`
   if they want a fallback caption. Quote hashtag captions: `DEFAULT_CAPTION="#brand #shorts"`.
3. **Start the control plane:** launch `npm run dashboard` as a **background** process (it's a
   long-running server) from the checkout. Confirm with `node <skill>/scripts/autosocial-cli.mjs
   ping`. Keep it running for the whole session; it does not auto-restart schedulers after a
   reboot.

If `node_modules`, `.env`, or Chromium is missing, fix setup before trying to publish — a missing
piece surfaces as a confusing mid-upload failure otherwise. `health` (below) tells you what's
missing in one call.

## Orchestration workflow

Assume the dashboard is running and you invoke the helper as
`node <skill>/scripts/autosocial-cli.mjs <command>`.

### 1. Assess

- `health` → dependency checks, per-platform **login session** status, and pending-queue counts
  for the active account. Start here; it tells you whether the user still needs to log in anywhere.
- `accounts` → the brands and which is active. `overview` → schedulers + queue counts everywhere.
- `status <platform>` → deep view for one platform: queue counts, `lastResult`, and recent `logs`
  (the first place to look after a failure).

### 2. Pick / create the brand account

Each brand is an isolated set of queues + browser sessions. Use `account:add "<name>"` to create
one (it becomes active) and `account:select <id>` to switch. Everything downstream (queue, login,
publish) targets the **active** account unless you pass `--account <id>`.

### 3. Log the account into each platform (human-in-the-loop)

For each platform the user wants:
1. `login <platform>` — a browser window opens on the real site.
2. **Hand off to the user** to sign in (password + 2FA). Say so explicitly; don't touch their
   credentials.
3. `login:status <platform>` to confirm, then `login:close <platform>`.

The session persists under `.profiles/<account>/<platform>` and is reused across runs, so this is
usually a one-time step per brand until the platform logs them out.

### 4. Prepare content

Get a video file (`.mp4/.mov/.webm/.avi/.mkv`) and a caption. Then:
`queue <platform> "<path-to-video>" --caption "your caption #tags"`

This copies the video into the platform's pending folder and writes a same-named `.txt` caption
sidecar. Queue for several platforms by repeating per platform. Check with `pending <platform>`.
If the user wants the same clip subtly varied per platform (to avoid duplicate-content flags),
run the **uniquifier** first — see `references/http-api.md` (uniquifier endpoints) and
`references/cli-and-config.md` (CLI `uniquify`).

### 5. Publish (only after explicit approval)

Choose the cadence that matches what the user asked for:

- **Post one now:** `publish <platform>` posts the next pending item immediately. Convenience:
  `post <platform> "<video>" --caption "..."` queues + publishes in one step. Best for the first
  real post — you both watch it go through.
- **Recurring by cron:** `schedule <platform> "0 */4 * * *"` (sets + starts). Cron is
  minute-hour-day-month-weekday in `TZ`.
- **Fixed daily times:** `schedule:daily <platform> 09:00,18:30` (24h local times; sets + starts).
- **Drop-to-post:** `instant <platform> on` auto-posts anything later dropped into the pending
  folder. Powerful and easy to over-post — confirm the user wants a hands-off watcher.
- **Control the loop:** `start` / `stop <platform>`.

Schedulers add jitter and do **not** survive a dashboard restart — if the user restarts, re-`start`
the platforms. After any publish, read `status <platform>` → `lastResult` and `logs` to report
what actually happened (posted file, or the error + screenshot path). Report failures honestly;
don't claim a post succeeded unless `lastResult.ok` is true.

### 6. Optional subsystems

- **Auto-download** (`/api/autodownload/*`): polls a TikTok channel with `yt-dlp` and fans new
  videos into pending queues. Needs `autodownload/yt-dlp.exe` (optional dependency).
- **Profile download** (`/api/profile-download/*`): scrape a TikTok profile's videos to disk
  without queueing.
- **Uniquifier** (`/api/uniquifier/*` or CLI `uniquify`): FFmpeg re-encode to make a clip unique.

See `references/http-api.md` for payloads.

## Reference files

- **`references/http-api.md`** — every dashboard endpoint, method, payload, and the same-origin
  header requirement. Read it when you need an endpoint the helper doesn't wrap, or to understand
  a response shape.
- **`references/cli-and-config.md`** — `npm` scripts, the TikTok-only `autosocial` CLI (`login`,
  `post`, `daemon`, `uniquify`, `video-info`), every `.env` variable, and the queue/profile folder
  layout.
- **`references/troubleshooting.md`** — what to do when an upload opens but never finishes, a
  session is "not found," the dashboard 403s a request, ffmpeg/yt-dlp is missing, or a schedule
  looks saved but nothing posts.

## Responsible use

The user is responsible for each platform's terms, rate limits, and content rights. Browser
automation of posting can put an account at risk if abused — favor modest cadences, real captions,
and content the user owns. Never help set up spam, engagement farming, or posting without consent.
If the user asks for a posting volume that looks like spam, say so and propose a saner cadence.
