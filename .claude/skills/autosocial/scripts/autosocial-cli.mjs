#!/usr/bin/env node
/**
 * autosocial-cli.mjs
 * -------------------
 * Thin orchestration wrapper around a running AutoSocial Studio dashboard.
 *
 * AutoSocial exposes its whole control plane as a local HTTP API on
 * http://127.0.0.1:3000 (see references/http-api.md). This script wraps that API
 * plus the file-based publish queue so an agent can drive AutoSocial with one
 * predictable command surface instead of re-deriving curl calls and folder
 * layouts every time.
 *
 * It uses ONLY Node built-ins (global fetch, fs, path) — no install step.
 * Requires Node 18+ (same as AutoSocial itself).
 *
 * Nothing here enters credentials or auto-confirms a public post. Publishing
 * commands (publish / post / instant on / start / schedule*) trigger real
 * uploads to real accounts — the caller is responsible for getting explicit
 * human approval first (the SKILL.md enforces this).
 *
 * Usage:  node autosocial-cli.mjs <command> [args] [--flags]
 * Run     node autosocial-cli.mjs help   for the full command list.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

// Project root: the AutoSocial checkout whose `queue/` the running dashboard uses.
// Default = 4 levels up from this script (<root>/.claude/skills/autosocial/scripts).
// Override with AUTOSOCIAL_ROOT or --root when the dashboard runs from a different
// checkout than the one holding this skill.
function resolveRoot(flags) {
  if (flags.root) return path.resolve(flags.root);
  if (process.env.AUTOSOCIAL_ROOT) return path.resolve(process.env.AUTOSOCIAL_ROOT);
  return path.resolve(__dirname, "..", "..", "..", "..");
}

// Read DASHBOARD_HOST / DASHBOARD_PORT from <root>/.env if present, so the base
// URL matches the user's config without pulling in dotenv.
function readEnvFile(root) {
  const out = {};
  try {
    const text = fs.readFileSync(path.join(root, ".env"), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  } catch { /* no .env yet */ }
  return out;
}

function resolveBaseUrl(flags, root) {
  if (flags.url) return flags.url.replace(/\/$/, "");
  if (process.env.AUTOSOCIAL_URL) return process.env.AUTOSOCIAL_URL.replace(/\/$/, "");
  const env = readEnvFile(root);
  const host = env.DASHBOARD_HOST || "127.0.0.1";
  const port = env.DASHBOARD_PORT || "3000";
  return `http://${host}:${port}`;
}

// ---------------------------------------------------------------------------
// Platform + endpoint mapping
//
// Quirk worth knowing: TikTok uses the legacy unprefixed routes (/api/status,
// /api/run-once, ...) while Instagram and YouTube are namespaced
// (/api/instagram/*, /api/youtube/*). This helper hides that difference.
// ---------------------------------------------------------------------------

const PLATFORMS = ["tiktok", "instagram", "youtube"];

function normPlatform(p) {
  const key = String(p || "").toLowerCase();
  const alias = { ig: "instagram", insta: "instagram", yt: "youtube", tt: "tiktok" };
  const resolved = alias[key] || key;
  if (!PLATFORMS.includes(resolved)) {
    fail(`Unknown platform "${p}". Use one of: ${PLATFORMS.join(", ")} (aliases: ig, yt, tt).`);
  }
  return resolved;
}

// Build the API path for a platform action, honouring the TikTok legacy prefix.
function apiPath(platform, action) {
  if (platform === "tiktok") return `/api/${action}`;
  return `/api/${platform}/${action}`;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function api(method, apiPathStr, body, ctx) {
  const url = ctx.baseUrl + apiPathStr;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        // Same-origin guard: mutating requests need an Origin whose host matches
        // the dashboard Host header, otherwise the dashboard replies 403.
        origin: ctx.baseUrl,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    if (err && (err.cause?.code === "ECONNREFUSED" || /ECONNREFUSED|fetch failed/.test(String(err)))) {
      fail(
        `Cannot reach the dashboard at ${ctx.baseUrl}.\n` +
        `Start it first from the AutoSocial checkout:  npm run dashboard`
      );
    }
    fail(`Request to ${url} failed: ${err.message}`);
  }
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const msg = data && data.error ? data.error : `HTTP ${res.status}`;
    fail(`API ${method} ${apiPathStr} -> ${res.status}: ${msg}`);
  }
  return data;
}

// ---------------------------------------------------------------------------
// Accounts + queue (filesystem)
// ---------------------------------------------------------------------------

async function resolveAccountId(flags, ctx) {
  if (flags.account) return flags.account;
  const state = await api("GET", "/api/accounts", undefined, ctx);
  const active = state.activeAccount || (state.accounts && state.accounts[0]);
  if (!active) fail("No account found. Add one with:  account:add <name>");
  return active.id;
}

function pendingDir(root, accountId, platform) {
  return path.join(root, "queue", accountId, platform, "pending");
}

const VIDEO_EXTS = new Set([".mp4", ".mov", ".webm", ".avi", ".mkv"]);

async function queueVideo({ platform, videoPath, caption, accountId }, ctx) {
  const src = path.resolve(videoPath);
  if (!fs.existsSync(src)) fail(`Video not found: ${src}`);
  const ext = path.extname(src).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) {
    fail(`Unsupported video type "${ext}". Supported: ${[...VIDEO_EXTS].join(", ")}`);
  }
  const dir = pendingDir(ctx.root, accountId, platform);
  await fsp.mkdir(dir, { recursive: true });
  const base = path.basename(src, ext);
  const destVideo = path.join(dir, path.basename(src));
  await fsp.copyFile(src, destVideo);
  let captionFile = null;
  if (caption !== undefined && caption !== null && String(caption).length > 0) {
    captionFile = path.join(dir, `${base}.txt`);
    await fsp.writeFile(captionFile, String(caption), "utf8");
  }
  return { queuedVideo: destVideo, captionFile, pendingDir: dir };
}

async function listPending(root, accountId, platform) {
  const dir = pendingDir(root, accountId, platform);
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { pendingDir: dir, videos: [] };
  }
  const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
  const videos = [...names]
    .filter((n) => VIDEO_EXTS.has(path.extname(n).toLowerCase()))
    .sort()
    .map((n) => {
      const b = n.slice(0, -path.extname(n).length);
      const hasCaption = names.has(`${b}.txt`) || names.has(`${b}.description`);
      return { name: n, hasCaption };
    });
  return { pendingDir: dir, videos };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function out(obj) {
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}
function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Arg parsing:  <command> <positional...> --flag value  |  --flag=value | --bool
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("--")) { flags[key] = next; i++; }
        else flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

const HELP = `AutoSocial orchestration CLI (wraps the local dashboard API + publish queue)

Prereqs: the dashboard must be running -> from the AutoSocial checkout:  npm run dashboard
Base URL: ${"${AUTOSOCIAL_URL or .env DASHBOARD_HOST:PORT or 127.0.0.1:3000}"}

READ-ONLY (safe, no posting):
  ping                              Check the dashboard is up
  health                            First-run setup + dependency + session health
  accounts                          List accounts and the active one
  overview                          Scheduler/queue status across all accounts
  status <platform>                 Full status for a platform (queue counts, logs, lastResult)
  pending <platform> [--account id] List queued (pending) videos + whether each has a caption
  login:status <platform>           Whether a login browser session is currently open

ACCOUNTS:
  account:add <name>                Create a brand/account and make it active
  account:select <id>               Switch the active account

LOGIN (human-in-the-loop — a browser opens for the USER to sign in; never enter their credentials):
  login <platform>                  Open a browser to sign in and persist the session
  login:close <platform>            Close the login browser once the user is signed in

CONTENT:
  queue <platform> <video> [--caption "text"] [--account id]
                                    Copy a video (+ optional caption sidecar) into the pending queue

PUBLISH (⚠ posts to real public accounts — get explicit user approval first):
  publish <platform> [--account id] Post the NEXT pending video now (run-once)
  post <platform> <video> [--caption "text"] [--account id]
                                    queue + publish in one step
  schedule <platform> "<cron>"      Set a cron schedule (e.g. "0 */4 * * *"), then start
  schedule:daily <platform> <HH:MM,HH:MM,...>   Post at fixed local times, then start
  instant <platform> <on|off>       Auto-post any new file dropped into the pending folder
  start <platform> / stop <platform>   Start / stop the scheduler for a platform

Global flags:  --url <baseUrl>   --root <autosocialCheckout>   --account <id>
Platforms:     tiktok | instagram | youtube   (aliases: tt, ig, yt)`;

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (!cmd || cmd === "help" || flags.help) { out(HELP); return; }

  const root = resolveRoot(flags);
  const baseUrl = resolveBaseUrl(flags, root);
  const ctx = { root, baseUrl };

  switch (cmd) {
    case "ping": {
      const data = await api("GET", "/api/overview", undefined, ctx);
      out({ ok: true, dashboard: baseUrl, accountsTracked: Object.keys(data).length });
      return;
    }
    case "health":
      out(await api("GET", "/api/setup/health", undefined, ctx));
      return;
    case "accounts":
      out(await api("GET", "/api/accounts", undefined, ctx));
      return;
    case "overview":
      out(await api("GET", "/api/overview", undefined, ctx));
      return;
    case "account:add": {
      const name = positional[1] || flags.name;
      if (!name) fail("Usage: account:add <name>");
      out(await api("POST", "/api/accounts/add", { name }, ctx));
      return;
    }
    case "account:select": {
      const id = positional[1] || flags.account;
      if (!id) fail("Usage: account:select <accountId>");
      out(await api("POST", "/api/accounts/select", { accountId: id }, ctx));
      return;
    }
    case "status": {
      const platform = normPlatform(positional[1]);
      out(await api("GET", apiPath(platform, "status"), undefined, ctx));
      return;
    }
    case "pending": {
      const platform = normPlatform(positional[1]);
      const accountId = await resolveAccountId(flags, ctx);
      out(await listPending(root, accountId, platform));
      return;
    }
    case "login": {
      const platform = normPlatform(positional[1]);
      const res = await api("POST", apiPath(platform, "login"), {}, ctx);
      out({
        ...res,
        note: `A browser opened for ${platform}. The USER signs in there. ` +
              `Do NOT type their credentials. Verify with 'login:status ${platform}', ` +
              `then run 'login:close ${platform}'.`,
      });
      return;
    }
    case "login:status": {
      const platform = normPlatform(positional[1]);
      out(await api("GET", apiPath(platform, "login/status"), undefined, ctx));
      return;
    }
    case "login:close": {
      const platform = normPlatform(positional[1]);
      out(await api("POST", apiPath(platform, "login/close"), {}, ctx));
      return;
    }
    case "queue": {
      const platform = normPlatform(positional[1]);
      const video = positional[2];
      if (!video) fail("Usage: queue <platform> <video> [--caption \"text\"]");
      const accountId = await resolveAccountId(flags, ctx);
      const caption = typeof flags.caption === "string" ? flags.caption : undefined;
      out({ ok: true, account: accountId, ...(await queueVideo({ platform, videoPath: video, caption, accountId }, ctx)) });
      return;
    }
    case "publish": {
      const platform = normPlatform(positional[1]);
      out(await api("POST", apiPath(platform, "run-once"), {}, ctx));
      return;
    }
    case "post": {
      const platform = normPlatform(positional[1]);
      const video = positional[2];
      if (!video) fail("Usage: post <platform> <video> [--caption \"text\"]");
      const accountId = await resolveAccountId(flags, ctx);
      const caption = typeof flags.caption === "string" ? flags.caption : undefined;
      const queued = await queueVideo({ platform, videoPath: video, caption, accountId }, ctx);
      const result = await api("POST", apiPath(platform, "run-once"), {}, ctx);
      out({ ok: true, account: accountId, queued, publish: result });
      return;
    }
    case "schedule": {
      const platform = normPlatform(positional[1]);
      const expression = positional[2] || flags.cron;
      if (!expression) fail('Usage: schedule <platform> "<cron expression>"');
      const set = await api("POST", apiPath(platform, "schedule"), { expression }, ctx);
      const started = await api("POST", apiPath(platform, "start"), {}, ctx);
      out({ ok: true, schedule: set, started });
      return;
    }
    case "schedule:daily": {
      const platform = normPlatform(positional[1]);
      const csv = positional[2] || flags.times;
      if (!csv) fail("Usage: schedule:daily <platform> <HH:MM,HH:MM,...>");
      const times = String(csv).split(",").map((s) => s.trim()).filter(Boolean);
      const set = await api("POST", apiPath(platform, "schedule-plan"), { type: "daily-times", times }, ctx);
      const started = await api("POST", apiPath(platform, "start"), {}, ctx);
      out({ ok: true, schedule: set, started });
      return;
    }
    case "instant": {
      const platform = normPlatform(positional[1]);
      const mode = String(positional[2] || "").toLowerCase();
      if (!["on", "off", "true", "false"].includes(mode)) fail("Usage: instant <platform> <on|off>");
      const enabled = mode === "on" || mode === "true";
      out(await api("POST", apiPath(platform, "instant-post"), { enabled }, ctx));
      return;
    }
    case "start": {
      const platform = normPlatform(positional[1]);
      out(await api("POST", apiPath(platform, "start"), {}, ctx));
      return;
    }
    case "stop": {
      const platform = normPlatform(positional[1]);
      out(await api("POST", apiPath(platform, "stop"), {}, ctx));
      return;
    }
    default:
      fail(`Unknown command "${cmd}". Run 'node autosocial-cli.mjs help' for usage.`);
  }
}

main().catch((e) => fail(e.message));
