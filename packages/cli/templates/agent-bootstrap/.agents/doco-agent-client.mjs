#!/usr/bin/env node
// Minimal Doco agent client.
//
// Purpose: keep DOCO_ACCESS out of shell command text. The script reads
// the repo-root .env internally (shared by agents in this checkout),
// then sends the bearer credential from inside Node's fetch call. No
// dependencies; requires Node 18+ for global fetch.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const DEFAULT_HOST = "https://doco.to";
const DEFAULT_TIMEOUT_MS = 8000;
const PROJECT_ROOT = findProjectRoot(process.cwd());

const args = process.argv.slice(2);
const command = args.shift() ?? "";
const meta = takeFlag("--meta");
const host = normalizeHost(takeValue("--host") || readEnv("DOCO_HOST") || DEFAULT_HOST);
const timeoutMs = Number(takeValue("--timeout-ms") || DEFAULT_TIMEOUT_MS);

try {
  if (command === "bootstrap") {
    await runBootstrap();
  } else if (command === "search") {
    await runSearch();
  } else {
    finish(fail("usage", usage()), 2);
  }
} catch (error) {
  finish(fail("internal", error instanceof Error ? error.message : String(error)), 1);
}

async function runBootstrap() {
  const url = new URL("/api/v1/agent-bootstrap.json", host);
  finish(await requestJsonWithAuth(url));
}

async function runSearch() {
  const query = takeValue("--q") || takeValue("--query") || args.join(" ").trim();
  if (!query) return finish(fail("usage", "search requires --q <query>"), 2);

  const handle = readEnv("DOCO_HANDLE") || readDocoHandle();
  if (!handle) {
    return finish(fail("missing_doco_handle", "missing Doco URL in .doco/connections.md"), 2);
  }

  const url = new URL(`/${encodeURIComponent(handle)}/search.json`, host);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", takeValue("--limit") || "10");
  finish(await requestJsonWithAuth(url));
}

async function requestJsonWithAuth(url) {
  let access = readAccess();
  let refreshed = false;
  if (!access) {
    const refresh = await refreshStoredCredential();
    if (refresh.ok) {
      access = refresh.access;
      refreshed = true;
    }
  }
  if (!access) return fail("missing_access", "missing DOCO_ACCESS");

  let result = await requestJson(url, { access });
  if (result.status === 401 && access.startsWith("doco_at_")) {
    const refresh = await refreshStoredCredential();
    if (refresh.ok) {
      result = await requestJson(url, { access: refresh.access });
      refreshed = true;
    } else {
      result.refresh_error = refresh.error;
    }
  }
  if (refreshed && result.ok) result.refreshed = true;
  return result;
}

async function refreshStoredCredential() {
  const refreshToken = readEnv("DOCO_REFRESH").trim();
  const clientId = readEnv("DOCO_CLIENT_ID").trim();
  if (!refreshToken || !clientId) {
    return fail("missing_refresh", "missing DOCO_REFRESH or DOCO_CLIENT_ID");
  }
  const url = new URL("/oauth/token", host);
  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const result = await requestJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  const access = String(result.body?.access_token || "").trim();
  if (!result.ok || !access) {
    return fail("refresh_failed", result.error || "refresh token exchange failed");
  }
  writeEnvUpdates({
    DOCO_ACCESS: access,
    ...(result.body?.refresh_token ? { DOCO_REFRESH: String(result.body.refresh_token) } : {}),
    DOCO_CLIENT_ID: clientId,
  });
  return { ok: true, access };
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS,
  );
  try {
    const headers = { ...(options.headers || {}) };
    if (options.access) headers.Authorization = `Bearer ${options.access}`;
    const response = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body,
      signal: controller.signal,
    });
    const text = await response.text();
    const body = parseJson(text);
    const result = {
      ok: response.ok,
      status: response.status,
      code: response.ok ? "ok" : "http",
      body,
    };
    if (!response.ok) {
      result.error = errorFromBody(body) || `HTTP ${response.status}`;
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(error?.name === "AbortError" ? "timeout" : "network", message);
  } finally {
    clearTimeout(timer);
  }
}

function finish(result, nonMetaExitCode = 1) {
  if (meta) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  }
  if (result.ok) {
    writeBody(result.body);
    process.exit(0);
  }
  process.stderr.write(`[Doco] ${result.error || result.code || "request failed"}\n`);
  if (result.body !== undefined) writeBody(result.body, process.stderr);
  process.exit(nonMetaExitCode);
}

function writeBody(body, stream = process.stdout) {
  if (typeof body === "string") {
    stream.write(body.endsWith("\n") ? body : `${body}\n`);
  } else {
    stream.write(`${JSON.stringify(body, null, 2)}\n`);
  }
}

function fail(code, error) {
  return { ok: false, status: 0, code, error };
}

function usage() {
  return [
    "Usage:",
    "  node .agents/doco-agent-client.mjs bootstrap [--meta]",
    "  node .agents/doco-agent-client.mjs search --q <query> [--limit 10] [--meta]",
  ].join("\n");
}

function takeFlag(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return false;
  args.splice(idx, 1);
  return true;
}

function takeValue(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return "";
  const value = args[idx + 1] ?? "";
  args.splice(idx, 2);
  return value;
}

function normalizeHost(raw) {
  return String(raw || DEFAULT_HOST).replace(/\/+$/, "") || DEFAULT_HOST;
}

function parseJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorFromBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  return String(body.error || body.warning || body.message || "");
}

function readEnv(name) {
  const envFile = readEnvFile();
  return envFile[name] || process.env[name] || "";
}

function readAccess() {
  return readEnv("DOCO_ACCESS").trim();
}

function readEnvFile() {
  const path = join(PROJECT_ROOT, ".env");
  if (!existsSync(path)) return {};
  const out = {};
  for (const rawLine of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    out[match[1]] = unquote(match[2].trim());
  }
  return out;
}

function writeEnvUpdates(updates) {
  const path = join(PROJECT_ROOT, ".env");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const updateKeys = new Set(Object.keys(updates));
  const keepLines = existing.split(/\r?\n/).filter((line) => {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    return !(match && updateKeys.has(match[1]));
  });
  while (keepLines.length > 0 && keepLines[keepLines.length - 1] === "") keepLines.pop();
  for (const [key, value] of Object.entries(updates)) {
    keepLines.push(`${key}=${value}`);
  }
  keepLines.push("");
  writeFileSync(path, keepLines.join("\n"), { mode: 0o600 });
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readDocoHandle() {
  for (const relativePath of [".doco/connections.md"]) {
    const path = join(PROJECT_ROOT, relativePath);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const matches = text.matchAll(/https?:\/\/[^/\s)]+\/([A-Za-z0-9][A-Za-z0-9-]*)\/?/g);
    for (const match of matches) {
      const handle = match[1];
      if (handle !== "invite" && handle !== "api") return handle;
    }
  }
  return "";
}

function findProjectRoot(start) {
  let dir = resolve(start);
  while (true) {
    if (existsSync(join(dir, ".doco", "connections.md"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return resolve(start);
    dir = parent;
  }
}
