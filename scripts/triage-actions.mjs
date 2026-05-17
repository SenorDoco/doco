#!/usr/bin/env node
// Triage script — re-classify existing Action rows after the Action/Log split.
//
// For each Action in the target Doco, asks gpt-4o-mini to decide whether it
// is:
//   - Action  → a designed step in a process (BPMN/UML sense; verb in
//               imperative/present; describes WHAT happens at a point in a
//               flow, not a specific occurrence)
//   - Log     → a recorded happening (concrete event with timestamp +
//               outputs; commit pushed, deploy completed, eval verified)
//   - Intent  → a misclassified work item (a backlog entry, a phase/epic
//               marker, an aspirational goal — belongs as Intent, not as
//               Action)
//
// Writes proposals to ./triage-actions-proposals.json for human review.
// Does NOT mutate the Doco — review the JSON, then run the apply pass (or
// just hand-edit the obvious ones via doco supersede).
//
// Usage:
//   DOCO_ID=doco_... node scripts/triage-actions.mjs
//   # or read DOCO_ID from the local AGENTS.md header automatically.
//
// Requires DOCO_ACCESS in the environment or ./.env, and OPENAI_API_KEY.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnvFile } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = pathResolve(__dirname, "..");
const DOCO_HOST = process.env.DOCO_HOST ?? "https://doco.to";
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
const PROPOSALS_OUT = pathResolve(process.cwd(), "triage-actions-proposals.json");

function loadDotEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const p = join(dir, ".env");
    if (existsSync(p)) {
      try {
        loadEnvFile(p);
      } catch {}
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

async function readDocoIdFromAgentsMd() {
  const p = pathResolve(REPO_ROOT, "AGENTS.md");
  if (!existsSync(p)) return null;
  const text = await readFile(p, "utf8");
  const m = text.match(/`(doco_[0-9A-HJKMNP-TV-Z]{26})`/);
  return m ? m[1] : null;
}

if (!process.env.DOCO_ACCESS || !process.env.OPENAI_API_KEY) loadDotEnv();

const DOCO_ACCESS = process.env.DOCO_ACCESS;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!DOCO_ACCESS) {
  console.error("Missing DOCO_ACCESS — set it in env or ./.env");
  process.exit(2);
}
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY — set it in env or ./.env");
  process.exit(2);
}

const DOCO_ID = process.env.DOCO_ID ?? (await readDocoIdFromAgentsMd());
if (!DOCO_ID) {
  console.error("Missing DOCO_ID — pass it in env or stamp it in AGENTS.md");
  process.exit(2);
}

async function docoFetch(path) {
  const res = await fetch(`${DOCO_HOST}${path}`, {
    headers: { Authorization: `Bearer ${DOCO_ACCESS}` },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`${path} → ${res.status} ${res.statusText}`);
  return res.json();
}

async function listActionsViaSearch() {
  // Vector search with a broad query, filtered to node_type=action. Pull
  // a big batch (limit=200) then de-dup by id.
  const queries = [
    "action verb performed completed",
    "deploy commit push phase rollout",
    "backlog todo plan implement",
    "audit cleanup migration",
  ];
  const seen = new Map();
  for (const q of queries) {
    const data = await docoFetch(
      `/by-id/${encodeURIComponent(DOCO_ID)}/search.json?q=${encodeURIComponent(q)}&limit=200`,
    );
    for (const h of data.hits ?? []) {
      if (h.node_type === "action" && !seen.has(h.id)) {
        seen.set(h.id, { id: h.id, summary: h.summary ?? "" });
      }
    }
  }
  return Array.from(seen.values());
}

async function fetchActionBody(id) {
  try {
    const data = await docoFetch(
      `/by-id/${encodeURIComponent(DOCO_ID)}/api/actions/${encodeURIComponent(id)}.json`,
    );
    return {
      id,
      summary: data.summary ?? "",
      body_md: data.body_md ?? "",
      raw_yaml: data.raw_yaml ?? "",
      lifecycle: data.lifecycle ?? "",
    };
  } catch (e) {
    return { id, summary: "", body_md: "", raw_yaml: "", error: String(e) };
  }
}

const SYSTEM_PROMPT = `You re-classify Doco Action entities after a schema split.

Each Action you see is currently typed as "action" but the new schema has three valid targets:

- "action" — A DESIGNED STEP in a process. BPMN/UML sense: a kind of thing that happens at a point in a flow. Verb is imperative or present tense ("user clicks Buy", "system charges card"). Inputs/outputs describe expected shapes, not concrete values. Has a clear actor (role like "user"/"system" or a specific principal). Reusable / template-like.

- "log" — A RECORDED HAPPENING. A specific event that occurred at a point in time. Past-tense verb ("pushed", "deployed", "verified"). Has concrete output values (commit hash, deploy URL, metric, file path). Tied to a real timestamp.

- "intent" — A MISCLASSIFIED WORK ITEM. A backlog entry, phase/epic marker, aspirational goal, or generic future-tense work description with no specific actor or concrete outputs. Belongs as Intent, not Action.

Examples:
- "user clicks Buy button" → action (designed step in a flow)
- "Snapshot commit abc123 pushed to main" → log (concrete event)
- "Phase 21 — scope mgmt UX expansion" → intent (epic marker, no specific actor)
- "Backlog: thorough sweep for code cleanup" → intent (TODO/backlog item)
- "Final verify ZQTM-mark" → log (specific verification result)
- "Async probe ZAQX (delete me)" → intent (debug/exploration; maybe even abandon)

Return JSON only: {"classification": "action" | "log" | "intent", "reason": "<one sentence>", "confidence": 0.0..1.0}`;

async function classify({ id, summary, body_md }) {
  const userPrompt = `Action id: ${id}\n\nsummary: ${summary}\n\nbody_md (truncated):\n${(body_md ?? "").slice(0, 1500)}`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI ${res.status}: ${text}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI returned no content");
  return JSON.parse(content);
}

async function main() {
  console.log(`Doco: ${DOCO_ID}`);
  console.log(`Host: ${DOCO_HOST}`);
  console.log("Listing actions via search…");
  const actions = await listActionsViaSearch();
  console.log(`Found ${actions.length} actions.`);
  if (actions.length === 0) {
    console.log("Nothing to triage.");
    return;
  }
  const proposals = [];
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    process.stdout.write(`[${i + 1}/${actions.length}] ${a.id}… `);
    const body = await fetchActionBody(a.id);
    try {
      const verdict = await classify(body);
      const row = {
        id: a.id,
        summary: a.summary,
        current_type: "action",
        proposed_type: verdict.classification,
        reason: verdict.reason,
        confidence: verdict.confidence,
      };
      proposals.push(row);
      process.stdout.write(`${verdict.classification} (${(verdict.confidence ?? 0).toFixed(2)})\n`);
    } catch (e) {
      proposals.push({
        id: a.id,
        summary: a.summary,
        current_type: "action",
        proposed_type: "error",
        reason: String(e),
      });
      process.stdout.write(`error: ${e}\n`);
    }
  }
  await writeFile(PROPOSALS_OUT, JSON.stringify(proposals, null, 2), "utf8");
  console.log(`\nProposals written: ${PROPOSALS_OUT}`);

  const counts = { action: 0, log: 0, intent: 0, error: 0 };
  for (const p of proposals) counts[p.proposed_type] = (counts[p.proposed_type] ?? 0) + 1;
  console.log("Summary:", counts);
  console.log(
    "\nNext: hand-review the proposals JSON, then promote/demote individually via doco supersede + capture log / capture intent.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
