#!/usr/bin/env node
// The Doco hook: one script that briefs an agent before it acts, for Claude
// Code, Codex and Gemini CLI. Served at /agents/doco-hook.mjs; a project
// keeps it at .doco/hook.mjs and names it in its client's hooks.
//
//   SessionStart (every client): the workspace's standing orders, with what
//     changed since the last session started from this project.
//   UserPromptSubmit (Claude Code, Codex) and BeforeAgent (Gemini CLI):
//     the reminder line, then a brief about the prompt.
//   PreToolUse on Edit, Write or MultiEdit (Claude Code, Codex): a brief on
//     the file about to change, once per session and file.
//
// The brief comes from GET <origin>/api/v1/brief.json (the standing orders
// from /api/v1/standing-orders.json) with a hook token
// (.doco/hook-tokens.json keyed by workspace handle, or DOCO_TOKEN) or an
// OAuth token (DOCO_ACCESS). The workspace and the origin come from the
// `Doco workspace:` line of AGENTS.md or CLAUDE.md, or DOCO_WORKSPACE and
// DOCO_ORIGIN. The output is the hookSpecificOutput.additionalContext JSON
// every client reads. Without a token (the file stays out of git, so a fresh
// clone has none), or with one Doco refuses (revoked, or a project token from
// before hook tokens), it tells the agent to get its person's from Doco's
// doco_hook_token, at session start and after the reminder on a prompt.
// Anything that fails, including the deadline, fails open: the reminder
// alone on a prompt, nothing on a file or at session start; exit 0 either
// way. No dependencies; Node 18 or later.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The same line as DOCO_REMINDER in lib/agent-instructions.ts (a test holds them equal). */
export const DOCO_REMINDER =
  "Doco: doco_brief before you act, capture each decision as it forms, and log this chat in Agents chats.";

const DEFAULT_ORIGIN = "https://doco.to";
const PROMPT_BUDGET = 4000;
const FILE_BUDGET = 1500;
const ABOUT_MAX = 2000;
const DEFAULT_TIMEOUT_MS = 8000;
/** A file's brief holds for the session this long before it is fetched again. */
const FILE_BRIEF_TTL_MS = 30 * 60_000;
const SESSION_EVENTS = new Set(["SessionStart"]);
const PROMPT_EVENTS = new Set(["UserPromptSubmit", "BeforeAgent"]);
const FILE_EVENTS = new Set(["PreToolUse"]);

/** Walk up from `cwd` to the first directory holding one of `names`. */
function findUp(cwd, names) {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of names) {
      const path = join(dir, name);
      if (existsSync(path)) return { dir, path };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** The `Doco workspace:` line of the project's AGENTS.md or CLAUDE.md. */
export function readProjectWorkspace(cwd) {
  const found = findUp(cwd, ["AGENTS.md", "CLAUDE.md"]);
  if (!found) return null;
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const path = join(found.dir, name);
    if (!existsSync(path)) continue;
    const match = readFileSync(path, "utf8").match(/^Doco workspace:\s*(\S+)/m);
    if (!match) continue;
    try {
      const url = new URL(match[1]);
      const workspace = url.pathname.match(/\/workspaces\/([^/]+)/)?.[1] ?? null;
      return { root: found.dir, origin: url.origin, workspace };
    } catch {
      return { root: found.dir, origin: null, workspace: null };
    }
  }
  return { root: found.dir, origin: null, workspace: null };
}

/** The token saved at .doco/hook-tokens.json, for the workspace or the only one. */
export function readHookToken(cwd, workspace) {
  const found = findUp(cwd, [join(".doco", "hook-tokens.json")]);
  if (!found) return null;
  try {
    const entries = Object.entries(JSON.parse(readFileSync(found.path, "utf8")));
    const named = entries.find(([key]) => key === workspace);
    const [, token] = named ?? (entries.length === 1 ? entries[0] : []);
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

export function resolveConfig(env, cwd) {
  const project = readProjectWorkspace(cwd);
  const workspace = env.DOCO_WORKSPACE || project?.workspace || null;
  return {
    root: project?.root ?? resolve(cwd),
    origin: (env.DOCO_ORIGIN || project?.origin || DEFAULT_ORIGIN).replace(/\/+$/, ""),
    workspace,
    // The saved token first: it is the one doco_hook_token gave the agent.
    token: readHookToken(cwd, workspace) || env.DOCO_TOKEN || env.DOCO_ACCESS || null,
    timeoutMs: Number(env.DOCO_HOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    budget: Number(env.DOCO_BRIEF_BUDGET) || PROMPT_BUDGET,
  };
}

/** When a session last started from this project and workspace, as the standing orders' `since`. */
function lastSeenFile(config) {
  const key = createHash("sha1")
    .update(`${config.root}|${config.workspace ?? ""}`)
    .digest("hex");
  return join(tmpdir(), "doco-hook", "last-seen", key);
}

function readLastSeen(config) {
  try {
    const seen = readFileSync(lastSeenFile(config), "utf8").trim();
    return Number.isNaN(Date.parse(seen)) ? null : seen;
  } catch {
    return null;
  }
}

/** What to fetch for an event, or null when the event calls for no brief. */
export function requestFor(event, config) {
  const name = String(event.hook_event_name ?? "");
  const params = new URLSearchParams();
  if (config.workspace) params.set("workspace", config.workspace);
  params.set("format", "text");
  if (SESSION_EVENTS.has(name)) {
    const since = readLastSeen(config);
    if (since) params.set("since", since);
    return {
      url: `${config.origin}/api/v1/standing-orders.json?${params}`,
      cacheKey: null,
      marksSeen: true,
    };
  }
  if (PROMPT_EVENTS.has(name)) {
    const prompt = String(event.prompt ?? "").trim();
    if (!prompt || prompt.startsWith("/")) return null;
    params.set("about", prompt.length > ABOUT_MAX ? prompt.slice(0, ABOUT_MAX) : prompt);
    params.set("budget", String(config.budget));
    return {
      url: `${config.origin}/api/v1/brief.json?${params}`,
      cacheKey: null,
      marksSeen: false,
    };
  }
  if (FILE_EVENTS.has(name)) {
    const input = event.tool_input ?? {};
    const raw = typeof input.file_path === "string" ? input.file_path : input.path;
    if (typeof raw !== "string" || !raw.trim()) return null;
    const path =
      isAbsolute(raw) && !relative(config.root, raw).startsWith("..")
        ? relative(config.root, raw)
        : raw;
    params.set("touching", path);
    params.set("budget", String(Math.min(FILE_BUDGET, config.budget)));
    params.set("synthesize", "0");
    return {
      url: `${config.origin}/api/v1/brief.json?${params}`,
      cacheKey: `file:${path}`,
      marksSeen: false,
    };
  }
  return null;
}

function cacheFile(sessionId, cacheKey) {
  const dir = join(tmpdir(), "doco-hook", String(sessionId || "no-session"));
  return join(dir, `${createHash("sha1").update(cacheKey).digest("hex")}.txt`);
}

function freshInCache(path) {
  try {
    return Date.now() - statSync(path).mtimeMs < FILE_BRIEF_TTL_MS;
  } catch {
    return false;
  }
}

async function fetchBrief(url, config) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.token}`, Accept: "text/plain" },
      signal: controller.signal,
    });
    if (res.status === 401) return { refused: true };
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text ? { text } : null;
  } finally {
    clearTimeout(timer);
  }
}

/** The hook's stdout for one event's stdin, or null for nothing. */
export async function main(stdinText, env = process.env, cwd = process.cwd()) {
  let event;
  try {
    event = JSON.parse(stdinText);
  } catch {
    return null;
  }
  const config = resolveConfig(env, typeof event.cwd === "string" ? event.cwd : cwd);
  const request = requestFor(event, config);
  const output = (additionalContext) =>
    JSON.stringify({
      hookSpecificOutput: { hookEventName: event.hook_event_name, additionalContext },
    });
  const onPrompt = PROMPT_EVENTS.has(String(event.hook_event_name));
  if (!request) return onPrompt ? output(DOCO_REMINDER) : null;
  // Without a token Doco takes, the agent gets its person's from doco_hook_token.
  const askForToken = (why) => {
    if (FILE_EVENTS.has(String(event.hook_event_name))) return null;
    const note = `${why}: call doco_hook_token${config.workspace ? ` for ${config.workspace}` : ""}, save the token as it says, and the hook briefs you from the next prompt on.`;
    return output(onPrompt ? `${DOCO_REMINDER}\n\n${note}` : note);
  };
  if (!config.token) return askForToken("The Doco hook has no token here");
  const cache = request.cacheKey ? cacheFile(event.session_id, request.cacheKey) : null;
  if (cache && freshInCache(cache)) return null;
  let fetched = null;
  try {
    fetched = await fetchBrief(request.url, config);
  } catch (error) {
    process.stderr.write(`Doco hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  if (fetched?.refused) return askForToken("Doco refused the Doco hook's token");
  const brief = fetched?.text ?? null;
  if (brief && cache) {
    try {
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, brief);
    } catch {
      /* a cache miss next time is fine */
    }
  }
  if (brief && request.marksSeen) {
    try {
      const seen = lastSeenFile(config);
      mkdirSync(dirname(seen), { recursive: true });
      writeFileSync(seen, new Date().toISOString());
    } catch {
      /* the next session gets the default window */
    }
  }
  if (!onPrompt) return brief ? output(brief) : null;
  return output(brief ? `${DOCO_REMINDER}\n\n${brief}` : DOCO_REMINDER);
}

async function run() {
  let input = "";
  try {
    for await (const chunk of process.stdin) input += chunk;
    const out = await main(input);
    if (out) process.stdout.write(`${out}\n`);
  } catch (error) {
    process.stderr.write(`Doco hook: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
