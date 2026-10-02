#!/usr/bin/env node
// The Doco hook: one script that briefs an agent before it acts, for Claude
// Code, Codex and Gemini CLI. Served at /agents/doco-hook.mjs; a project
// keeps it at .doco/hook.mjs and names it in its client's hooks.
//
//   UserPromptSubmit (Claude Code, Codex) and BeforeAgent (Gemini CLI):
//     the reminder line, then a brief about the prompt.
//   PreToolUse on Edit, Write or MultiEdit (Claude Code, Codex): a brief on
//     the file about to change, once per session and file.
//
// The brief comes from GET <origin>/api/v1/brief.json with a project token
// (DOCO_TOKEN, or .doco/project-tokens.json keyed by workspace handle) or an
// OAuth token (DOCO_ACCESS). The workspace and the origin come from the
// `Doco workspace:` line of AGENTS.md or CLAUDE.md, or DOCO_WORKSPACE and
// DOCO_ORIGIN. The output is the hookSpecificOutput.additionalContext JSON
// every client reads. Anything that fails, including the deadline, fails
// open: the reminder alone on a prompt, nothing on a file; exit 0 either
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

/** The token committed at .doco/project-tokens.json, for the workspace or the only one. */
export function readProjectToken(cwd, workspace) {
  const found = findUp(cwd, [join(".doco", "project-tokens.json")]);
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
    token: env.DOCO_TOKEN || env.DOCO_ACCESS || readProjectToken(cwd, workspace),
    timeoutMs: Number(env.DOCO_HOOK_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    budget: Number(env.DOCO_BRIEF_BUDGET) || PROMPT_BUDGET,
  };
}

/** What to fetch for an event, or null when the event calls for no brief. */
export function requestFor(event, config) {
  const name = String(event.hook_event_name ?? "");
  const params = new URLSearchParams();
  if (config.workspace) params.set("workspace", config.workspace);
  params.set("format", "text");
  if (PROMPT_EVENTS.has(name)) {
    const prompt = String(event.prompt ?? "").trim();
    if (!prompt || prompt.startsWith("/")) return null;
    params.set("about", prompt.length > ABOUT_MAX ? prompt.slice(0, ABOUT_MAX) : prompt);
    params.set("budget", String(config.budget));
    return { url: `${config.origin}/api/v1/brief.json?${params}`, cacheKey: null };
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
    return { url: `${config.origin}/api/v1/brief.json?${params}`, cacheKey: `file:${path}` };
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
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    return text || null;
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
  let brief = null;
  if (!config.token) {
    process.stderr.write(
      `Doco hook: no token. Set DOCO_TOKEN or commit .doco/project-tokens.json (${config.origin}/workspaces/${config.workspace ?? "<workspace>"}/project-tokens).\n`,
    );
  } else {
    const cache = request.cacheKey ? cacheFile(event.session_id, request.cacheKey) : null;
    if (cache && freshInCache(cache)) return null;
    try {
      brief = await fetchBrief(request.url, config);
    } catch (error) {
      process.stderr.write(
        `Doco hook: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    if (brief && cache) {
      try {
        mkdirSync(dirname(cache), { recursive: true });
        writeFileSync(cache, brief);
      } catch {
        /* a cache miss next time is fine */
      }
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
