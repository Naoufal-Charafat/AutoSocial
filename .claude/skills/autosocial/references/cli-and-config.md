# AutoSocial CLI, npm scripts, config & folder layout

Run everything from the AutoSocial checkout root (the folder with `package.json`).

## npm scripts

| Command | Purpose |
| --- | --- |
| `npm ci` | Install pinned dependencies. |
| `npx playwright install chromium` | Install the browser used for all uploads/logins. |
| `npm run doctor` | Verify Node, npm, FFmpeg, ffprobe, Playwright Chromium, yt-dlp, `.env.example`. |
| `npm run dashboard` | Start the control-plane server (long-running; run in background). |
| `npm run check` | Syntax check + unit tests (local logic only; no live platform access). |
| `npm run clean:debug` | Remove local debug screenshots and dashboard logs. |
| `npm run login` | **TikTok** login (CLI). |
| `npm run post` | **TikTok** post next from queue (CLI). |
| `npm run daemon` | **TikTok** scheduler daemon (CLI). |
| `npm run uniquify` | Video uniquifier (CLI). |
| `npm run video-info -- --video "C:\path\clip.mp4"` | Print ffprobe metadata. |
| `npm run autodownload` | Standalone yt-dlp channel watcher. |

## The `autosocial` CLI (`node src/cli.js <command>`)

The CLI covers **TikTok** publishing plus video tools. **Instagram and YouTube publishing are NOT
in the CLI** — use the dashboard API (or `scripts/autosocial-cli.mjs`) for those.

- `login` — open a browser to sign into TikTok and persist the session.
- `post [--video <path>] [--caption "<text>"]` — post a specific video, or the next TikTok queue item.
- `daemon` — run one post now, then start the cron scheduler.
- `uniquify [--video <path> | --dir <path>] [--in-place] [--overlay <img>] [--remove-audio] [--no-color-shift] [--no-hue-shift] [--no-noise] [--no-pixel-shift] [--no-speed-shift] [--no-audio-pitch] [--no-volume-shift]` — re-encode to make clips unique. Defaults to `queue/default/tiktok/pending` when no target given.
- `video-info --video <path>` — ffprobe metadata as JSON.

## Folder layout (per account)

```
queue/<account>/<platform>/pending    <- drop videos here to queue them
queue/<account>/<platform>/posted     <- successful uploads move here (timestamped)
queue/<account>/<platform>/failed     <- failed uploads move here (+ a last-*.png screenshot)
.profiles/<account>/<platform>        <- persisted Playwright login session (cookies etc.)
.scheduler-state/<account>/           <- per-platform scheduler state (cron / daily-times / instant)
```

`<platform>` is `tiktok`, `instagram`, or `youtube`. `<account>` is the account id (slug of the
brand name; the first account is `default`). Created automatically by the dashboard / account API.

### Caption sidecars

A caption is a text file next to the video with the **same base name**:
- `myclip.mp4` + `myclip.txt`  (or `myclip.description`)

If no sidecar exists, `DEFAULT_CAPTION` from `.env` is used. Supported video extensions:
`.mp4 .mov .webm .avi .mkv`.

## `.env` variables

Copy `.env.example` → `.env`. All optional; defaults in parentheses.

| Variable | (default) | Meaning |
| --- | --- | --- |
| `CRON_EXPRESSION` | `0 */2 * * *` | TikTok default cron. |
| `INSTAGRAM_CRON_EXPRESSION` | `0 */2 * * *` | Instagram default cron. |
| `YOUTUBE_CRON_EXPRESSION` | `0 */2 * * *` | YouTube default cron. |
| `TZ` | `UTC` | Timezone for all scheduling. **Set this to the user's zone.** |
| `BROWSER_LOCALE` | `en-US` | Locale for browser contexts. |
| `HEADLESS` | `false` | `true` runs uploads with no visible window (harder to debug; use only once flows are proven). |
| `POST_DELAY_MS` | `15000` | Wait after file upload before publish steps. |
| `POST_PUBLISH_HOLD_MS` | `25000` | Keep browser open after a successful post. |
| `FAILURE_HOLD_MS` | `8000` | Keep browser open after a failure (to inspect). |
| `AUTO_ADD_SOUND` | `false` | TikTok: try to add a sound before publishing. |
| `DEFAULT_SOUND_QUERY` | (empty) | TikTok sound search query. |
| `RANDOM_QUEUE_ORDER` | `false` | Pick a random pending file instead of alphabetical. |
| `DEFAULT_CAPTION` | (empty) | Fallback caption. Quote hashtags: `"#brand #shorts"`. |
| `TIKTOK_UPLOAD_URL` | tiktok studio upload | Override upload page. |
| `INSTAGRAM_UPLOAD_URL` | instagram create | Override upload page. |
| `YOUTUBE_UPLOAD_URL` | studio.youtube.com | Override upload page. |
| `DASHBOARD_HOST` | `127.0.0.1` | Bind host. Keep loopback. |
| `DASHBOARD_PORT` | `3000` | Bind port. |
| `DASHBOARD_ALLOW_REMOTE` | `false` | Must be `true` to bind a non-loopback host (risky). |
| `WATCH_CHANNEL` | (empty) | TikTok channel for auto-download. |
| `WATCH_INTERVAL` | `10` | Minutes between auto-download polls. |
| `WATCH_MAX_VIDEOS` | `5` | Videos checked per poll. |
| `WATCH_MIN_VIEWS` | `0` | Min-views filter for downloads. |
| `AUTO_POST_PLATFORMS` | `tiktok,instagram,youtube` | Platforms auto-download fans out to. |
| `UNIQUIFY_INPUT_DIR` / `UNIQUIFY_OUTPUT_DIR` | `queue/uniquify-input` / `-output` | Uniquifier folders. |
| `UNIQUIFY_LOGO_IMAGE` | (empty) | Optional overlay logo. |

Advanced single-account path overrides (`QUEUE_DIR`, `INSTAGRAM_QUEUE_DIR`, `*_PROFILE_DIR`, …)
exist for CLI/legacy setups but are unnecessary for the normal per-account dashboard flow.

## Security notes

- The dashboard binds to loopback and has **no auth** — keep it local. Binding remotely is blocked
  unless `DASHBOARD_ALLOW_REMOTE=true`.
- Runtime data (`.env`, `.profiles/`, `queue/`, `*-state.json`, screenshots, downloads) is
  git-ignored. Never commit sessions or media.
