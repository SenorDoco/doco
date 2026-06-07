#!/usr/bin/env node
// Live verification harness for a deployed Doco app.
//
// Drives a running instance end-to-end and writes a pass/fail report — the
// regime requested in docs/simplification-plan.md ("Verification regime"):
// every page, every perspective (with random node exploration), the API, MCP,
// and a doco created from each template + exercised. It specifically re-walks
// the paths the recent entity-shape normalization touched:
//   • Slice 1 (nodes): capture a node with `prose` (using the first node type
//     the template's allowlist accepts), read it back as the canonical
//     { prose, extra } shape (no type-named key), then EDIT it to force a
//     re-evaluation of the stored candidate — the path the original bug lived in
//     ("the candidate lacks a `prose` field") — and assert it does NOT fail.
//   • Slice 2 (edges): create a flows_to edge with label/condition/kind and
//     read them back from the typed columns; assert no `props` bag (skipped on
//     templates whose allowlist forbids action/state).
//   • Slice 3 (workspaces/host): workspace + dashboard pages render.
//
// Template-aware throughout: an authoring-policy allowlist rejection (HTTP 400
// "not in allowlist") is the policy WORKING, so the harness adapts to each
// template rather than reporting it as a failure.
//
// Usage:
//   node scripts/verify-live.mjs [baseUrl] [username]
//     baseUrl   default https://doco.to
//     username  default doco-test-harness  (must be a reserved dev-signin name)
//
// Auth: POSTs /auth/dev-signin to mint a `doco_session` cookie (see AGENTS.md).
// Browser phase uses the Playwright Chromium if present; it's skipped (not
// failed) when unavailable, so the HTTP/API/template phases still run anywhere.
//
// Exit code is non-zero if any check fails, so it doubles as a smoke gate.

import { existsSync, mkdirSync } from "node:fs";

const BASE = (process.argv[2] ?? "https://doco.to").replace(/\/$/, "");
const USERNAME = process.argv[3] ?? "doco-test-harness";
const SHOTS = "/tmp/verify-live-shots";
const CHROMIUM = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

const results = [];
let cookie = "";

function record(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const tag = ok ? "PASS" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? ` — ${detail}` : ""}`);
}

/** Run one check; any throw is a FAIL (the sweep never aborts on one failure). */
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail ?? "");
    return true;
  } catch (err) {
    record(name, false, err instanceof Error ? err.message : String(err));
    return false;
  }
}

async function http(path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    redirect: "manual",
    headers: { ...(cookie ? { cookie } : {}), ...(init.headers ?? {}) },
  });
  return res;
}

async function json(path, init) {
  const res = await http(path, init);
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ─── Phase 0: auth ────────────────────────────────────────────────────────────

async function signIn() {
  const res = await fetch(`${BASE}/auth/dev-signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: USERNAME, next: "/dashboard" }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const m = setCookie.match(/doco_session=([^;]+)/);
  if (!m) {
    throw new Error(
      `dev-signin did not set a session cookie (status ${res.status}). The gateway must be healthy for the sweep to run.`,
    );
  }
  cookie = `doco_session=${m[1]}`;
  return `status ${res.status}`;
}

// ─── Phase 1: static page sweep ───────────────────────────────────────────────

// Param-free pages every signed-in user can reach. Each must render (2xx) or
// redirect intentionally (3xx) — a 4xx/5xx is a failure.
const STATIC_PAGES = [
  "/",
  "/llms.txt",
  "/dashboard",
  "/workspaces",
  "/new-doco",
  "/new-workspace",
  "/users",
  "/integrations",
  "/tokens",
  "/api-keys",
  "/access-requests",
  "/onboarding/join",
  // NB: /feedback is intentionally admin-only (404 for anyone but `torrenegra`,
  // see routes/feedback.tsx), so it is NOT a general signed-in page — listing it
  // here would be a guaranteed false failure for the test user.
];

async function pageOk(path) {
  const res = await http(path);
  assert(res.status < 400, `GET ${path} → ${res.status}`);
  return `status ${res.status}`;
}

// ─── Phase 2: API sweep (param-free) ──────────────────────────────────────────

const API_PAGES = [
  "/api/v1/whoami.json",
  "/api/v1/workspaces.json",
  "/api/v1/docos.json",
  "/api/v1/me/preferences.json",
];

// ─── Phase 3: per-template create + exercise (the heart of the regime) ────────

const TEMPLATES = ["generic", "process"];

async function firstWorkspaceId() {
  const { status, body } = await json("/api/v1/workspaces.json");
  assert(status === 200, `workspaces.json → ${status}`);
  const list = Array.isArray(body) ? body : (body.workspaces ?? body.items ?? []);
  const id = list[0]?.id;
  assert(typeof id === "string" && id.startsWith("workspace_"), "no workspace to create docos in");
  return id;
}

async function createDoco(workspaceId, template) {
  const suffix = `verify-${template}-${Date.now().toString(36)}`;
  const { status, body } = await json("/api/v1/docos.json", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: suffix, workspace_id: workspaceId, template_handle: template }),
  });
  assert(
    status < 400,
    `create ${template} doco → ${status}: ${JSON.stringify(body).slice(0, 200)}`,
  );
  const handle = body.handle ?? body.qualified_handle ?? body.doco?.handle;
  assert(
    typeof handle === "string",
    `created doco has no handle: ${JSON.stringify(body).slice(0, 200)}`,
  );
  return handle;
}

// A doco's template enforces authoring policies: a node-type allowlist
// ("node_type … not in allowlist"), or structural gates ("missing required
// `attributed_to` edge to a principal", "missing required `supports` edge to a
// intent"). A 400 carrying "Authoring policy violation" is the policy WORKING,
// not a failure — detect it so the harness adapts to the template (skipping the
// exercises a stricter template can't satisfy without elaborate setup) instead
// of crying wolf. The typed-column / re-eval behavior under test is
// template-independent, so coverage on a permissive template (generic) suffices.
function isPolicyViolation(res) {
  return res.status === 400 && /Authoring policy violation/i.test(JSON.stringify(res.body));
}

/** The human-readable policy message, for a skip detail line. */
function policyReason(res) {
  const e = res.body?.error;
  return typeof e === "string"
    ? e.replace(/^Authoring policy violation:\s*/i, "")
    : `HTTP ${res.status}`;
}

// Capture a node carrying `prose`, then exercise the SLICE-1 re-evaluation path
// (the original bug: a re-eval of the STORED node must surface its `prose`, not
// fail with "the candidate lacks a `prose` field entirely"). Template-aware:
// tries node types in order and uses the first the template's allowlist accepts,
// so it runs on EVERY template (a template's allowlist may reject some types).
async function exerciseReeval(handle) {
  const candidates = [
    { type: "intent", collection: "intents" },
    { type: "reference", collection: "references" },
    { type: "rule", collection: "rules" },
  ];
  let chosen;
  let create;
  for (const c of candidates) {
    create = await json(`/${handle}/api/${c.collection}.json`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prose: "Find candidates" }),
    });
    if (create.status < 400) {
      chosen = c;
      break;
    }
    if (!isPolicyViolation(create)) {
      throw new Error(
        `capture ${c.type} → ${create.status}: ${JSON.stringify(create.body).slice(0, 200)}`,
      );
    }
  }
  assert(chosen, "no candidate node type accepted by this template's authoring policies");
  const id = create.body.id ?? create.body[chosen.type]?.id;
  assert(typeof id === "string", "captured node has no id");

  // Read back: canonical { prose, extra }, NO type-named key.
  const got = await json(`/${handle}/api/${chosen.collection}/${id}.json`);
  assert(got.status === 200, `read ${chosen.type} → ${got.status}`);
  const node = got.body[chosen.type] ?? got.body;
  assert(
    node.prose === "Find candidates",
    `read-back prose mismatch: ${JSON.stringify(got.body).slice(0, 200)}`,
  );
  assert(
    !(chosen.type in got.body),
    `read-back still carries the legacy type-named \`${chosen.type}\` key`,
  );

  // THE ORIGINAL BUG: editing the node re-evaluates the STORED candidate. It
  // must NOT fail with "the candidate lacks a `prose` field entirely".
  const patch = await json(`/${handle}/api/${chosen.collection}/${id}.json`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prose: "Find candidates (edited)" }),
  });
  const blob = JSON.stringify(patch.body);
  assert(
    !/lacks a .?prose.? field/i.test(blob),
    `re-evaluation regressed the original bug: ${blob.slice(0, 240)}`,
  );
  assert(patch.status < 500, `re-eval (prose edit) → ${patch.status}: ${blob.slice(0, 200)}`);
  return `${chosen.type} ${id}: capture/read/re-eval ok`;
}

// Create a flows_to edge with the SLICE-2 typed columns and read them back.
// Returns a "skipped" sentinel when the template's allowlist forbids the
// action/state endpoints a flow needs — that's the policy working, not an
// edge regression.
async function exerciseEdgeColumns(handle) {
  const a = await json(`/${handle}/api/actions.json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prose: "Review the application", lifecycle: "active" }),
  });
  const b = await json(`/${handle}/api/states.json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prose: "Approved", kind: "terminal", lifecycle: "active" }),
  });
  if (isPolicyViolation(a) || isPolicyViolation(b)) {
    const why = isPolicyViolation(a) ? policyReason(a) : policyReason(b);
    return `skipped — template policy blocks bare action/state (${why}); flows_to typed columns covered on generic`;
  }
  assert(a.status < 400 && b.status < 400, `capture flow nodes → ${a.status}/${b.status}`);
  const fromId = a.body.id;
  const toId = b.body.id;
  const edge = await json(`/${handle}/api/edges.json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      edge_type: "flows_to",
      from_id: fromId,
      to_id: toId,
      label: "Yes",
      condition: "score > 0",
      kind: "exception",
    }),
  });
  assert(
    edge.status < 400,
    `create flows_to edge → ${edge.status}: ${JSON.stringify(edge.body).slice(0, 200)}`,
  );
  const edgeId = edge.body.id ?? edge.body.edge?.id;
  if (edgeId) {
    const got = await json(`/${handle}/api/edges/${edgeId}.json`);
    assert(got.status === 200, `read edge → ${got.status}`);
    // The detail endpoint nests the edge under `{ edge: { … } }`; the list under
    // `{ edges: [ … ] }`. Unwrap before reading the typed columns.
    const e = got.body.edge ?? got.body;
    assert(
      e.label === "Yes" && e.condition === "score > 0" && e.kind === "exception",
      `flows_to metadata not on the typed columns: ${JSON.stringify(got.body).slice(0, 200)}`,
    );
    assert(!("props" in e), "edge still carries a `props` bag");
  }
  return "flows_to edge created with typed label/condition/kind";
}

// Walk a created doco's own pages + a sample of node pages.
async function walkDocoPages(handle) {
  for (const p of [
    `/${handle}`,
    `/${handle}/status.json`,
    `/${handle}/policies`,
    `/${handle}/perspectives`,
    `/${handle}/activity`,
    `/${handle}/edges`,
    `/${handle}/settings`,
    `/${handle}/api/authoring-contract.json`,
    `/${handle}/api/policies.json`,
    `/${handle}/api/principals.json`,
    `/${handle}/api/edges.json`,
  ]) {
    await check(`page ${p}`, () => pageOk(p));
  }
  // Node list + a random node detail for each node type that has a list page.
  // (Principals have no HTML list route — they surface via the org-tree
  // perspective; their API is covered by api/principals.json above.)
  for (const type of ["intents", "actions", "decisions", "states"]) {
    await check(`list /${handle}/${type}`, () => pageOk(`/${handle}/${type}`));
    const listing = await json(`/${handle}/api/${type}.json`);
    const rows = Array.isArray(listing.body)
      ? listing.body
      : (listing.body.items ?? listing.body[type] ?? []);
    if (Array.isArray(rows) && rows.length > 0) {
      const pick = rows[Math.floor(Math.random() * rows.length)];
      const id = pick.id;
      if (id)
        await check(`detail /${handle}/${type.replace(/s$/, "")}/${id}`, () =>
          pageOk(`/${handle}/${type.replace(/s$/, "")}/${id}`),
        );
    }
  }
}

// ─── Phase 4: perspectives via headless Chromium (screenshots) ────────────────

async function browserSweep(handles) {
  if (!existsSync(CHROMIUM)) {
    record(
      "browser perspective sweep",
      true,
      "SKIPPED — Chromium not present (HTTP phases cover render-status)",
    );
    return;
  }
  let puppeteer;
  try {
    puppeteer = (await import("puppeteer-core")).default;
  } catch {
    record("browser perspective sweep", true, "SKIPPED — puppeteer-core not installed");
    return;
  }
  mkdirSync(SHOTS, { recursive: true });
  const sessionValue = cookie.replace(/^doco_session=/, "");
  const host = new URL(BASE).hostname;
  const browser = await puppeteer.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setCookie({
      name: "doco_session",
      value: sessionValue,
      domain: host,
      path: "/",
      httpOnly: true,
      secure: BASE.startsWith("https"),
    });
    for (const handle of handles) {
      for (const view of ["", "/perspectives", "/edges"]) {
        await check(`screenshot ${handle}${view}`, async () => {
          const resp = await page.goto(`${BASE}/${handle}${view}`, {
            waitUntil: "networkidle2",
            timeout: 30000,
          });
          assert((resp?.status() ?? 0) < 400, `nav → ${resp?.status()}`);
          await page.screenshot({
            path: `${SHOTS}/${handle}${view.replace(/\//g, "_")}.png`,
            fullPage: false,
          });
          return `→ ${SHOTS}/${handle}${view.replace(/\//g, "_")}.png`;
        });
      }
    }
  } finally {
    await browser.close();
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`# Live verification of ${BASE} as ${USERNAME}\n`);

  if (!(await check("auth: dev-signin", signIn))) {
    console.log("\nAborting: cannot mint a session — the rest of the sweep needs auth.");
    summarize();
    process.exit(1);
  }

  console.log("\n## Static pages");
  for (const p of STATIC_PAGES) await check(`page ${p}`, () => pageOk(p));

  console.log("\n## API (param-free)");
  for (const p of API_PAGES)
    await check(`GET ${p}`, async () => {
      const { status } = await json(p);
      assert(status < 400, `→ ${status}`);
      return `status ${status}`;
    });

  console.log("\n## Templates: create + exercise");
  const handles = [];
  let workspaceId;
  const wsOk = await check("resolve a workspace", async () => {
    workspaceId = await firstWorkspaceId();
    return workspaceId;
  });
  if (wsOk) {
    for (const t of TEMPLATES) {
      try {
        const handle = await createDoco(workspaceId, t);
        handles.push(handle);
        record(`created "${t}" → ${handle}`, true);
        await check(`[${t}] node capture + re-eval (original bug)`, () => exerciseReeval(handle));
        await check(`[${t}] flows_to edge typed columns`, () => exerciseEdgeColumns(handle));
        await walkDocoPages(handle);
      } catch (err) {
        record(`exercise "${t}"`, false, err instanceof Error ? err.message : String(err));
      }
    }
  }

  console.log("\n## Perspectives (headless screenshots)");
  await browserSweep(handles);

  summarize();
}

function summarize() {
  const fail = results.filter((r) => !r.ok);
  console.log(`\n## Summary: ${results.length - fail.length}/${results.length} passed`);
  if (fail.length) {
    console.log("Failures:");
    for (const f of fail) console.log(`  ✗ ${f.name} — ${f.detail}`);
  }
  process.exitCode = fail.length ? 1 : 0;
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(2);
});
