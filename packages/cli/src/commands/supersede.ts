// `doco supersede <id>` — convenience for the supersession workflow
// (decision_01KRKEPRAMM9QSSEJ2X5FHPESJ).
//
// Two-step under the hood:
//   1. POST /by-id/<doco_id>/api/decisions.json — capture a new Decision
//                                                  that supersedes the prior.
//   2. PATCH /by-id/<doco_id>/api/decisions/<prior>.json — set lifecycle to
//                                                           "superseded".
//
// Today only Decisions are supported (the most common case). Intent,
// Rule, Action supersession would mirror this — followup if needed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { c, cross, checkmark } from "../output.js";

const DOCO_BASE_URL = "https://doco.to";

type Env = { token: string; docoId: string };

function loadDotenv(): void {
  for (const k of ["DOCO_TOKEN", "DOCO_ID"] as const) {
    if (process.env[k]) continue;
    try {
      const text = readFileSync(resolve(process.cwd(), ".env"), "utf8");
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^\s*export\s+/, "");
        const m = line.match(/^([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (!m) continue;
        let v = m[2];
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!process.env[m[1]]) process.env[m[1]] = v;
      }
      break;
    } catch {
      break;
    }
  }
}

function requireEnv(): Env {
  loadDotenv();
  const token = process.env.DOCO_TOKEN ?? "";
  const docoId = process.env.DOCO_ID ?? "";
  const missing = Object.entries({ DOCO_TOKEN: token, DOCO_ID: docoId })
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    console.error(cross(`Missing env: ${missing.join(", ")}. Set in shell or in ./.env.`));
    process.exit(2);
  }
  return { token, docoId };
}

export const supersedeCmd = defineCommand({
  meta: {
    name: "supersede",
    description:
      "Capture a new Decision that supersedes the prior, then mark the prior as superseded. Two HTTP calls hidden behind one CLI invocation.",
  },
  args: {
    id: {
      type: "positional",
      description: "The prior Decision's ULID (e.g. 'decision_01KR…').",
      required: true,
    },
    question: {
      type: "string",
      description:
        "Question the new Decision answers. Defaults to 'Revisit <prior-id>' if omitted; better to supply a real question.",
    },
    chosen: {
      type: "string",
      description: "The chosen resolution for the new Decision. Required.",
      required: true,
    },
    summary: {
      type: "string",
      description: "Optional one-line summary; derived from chosen if absent.",
    },
    scope: {
      type: "string",
      description:
        "Comma-separated scope names for the new Decision. Required (the framework rejects scope-less captures).",
      required: true,
    },
    "intent-id": {
      type: "string",
      description: "Comma-separated intent ids to link on the new Decision.",
    },
    "body-md": {
      type: "string",
      description: "Markdown body for the new Decision (inline string).",
    },
    "body-md-file": {
      type: "string",
      description: "Path to a file whose contents become body_md on the new Decision.",
    },
    "decided-by-username": {
      type: "string",
      description: "Optional principal username to set as decided_by on the new Decision.",
    },
    "prior-lifecycle": {
      type: "string",
      description:
        "Lifecycle to set on the prior Decision. Default 'superseded'; pass 'abandoned' to retire without a successor (rare in supersede flow).",
    },
  },
  async run({ args }) {
    const priorId = String(args.id);
    if (!priorId.startsWith("decision_")) {
      console.error(cross(`'${priorId}' is not a Decision id. doco supersede only handles Decisions today.`));
      process.exit(2);
    }

    const chosen = String(args.chosen ?? "").trim();
    if (!chosen) {
      console.error(cross("--chosen is required (the resolution the new Decision codifies)."));
      process.exit(2);
    }
    const scope = String(args.scope ?? "").trim();
    if (!scope) {
      console.error(cross("--scope is required (comma-separated scope names)."));
      process.exit(2);
    }

    let bodyMd: string | undefined;
    if (args["body-md"] && args["body-md-file"]) {
      console.error(cross("Pass only one of --body-md and --body-md-file."));
      process.exit(2);
    }
    if (args["body-md-file"]) {
      bodyMd = readFileSync(resolve(process.cwd(), String(args["body-md-file"])), "utf8");
    } else if (args["body-md"]) {
      bodyMd = String(args["body-md"]);
    }

    const { token, docoId } = requireEnv();

    const captureBody: Record<string, unknown> = {
      question: String(args.question ?? `Supersede ${priorId} — what changes?`),
      chosen,
      scope_names: scope.split(",").map((s) => s.trim()).filter(Boolean),
    };
    if (args.summary) captureBody.summary = String(args.summary);
    if (args["intent-id"]) {
      captureBody.intent_ids = String(args["intent-id"]).split(",").map((s) => s.trim()).filter(Boolean);
    }
    if (bodyMd !== undefined) captureBody.body_md = bodyMd;
    if (args["decided-by-username"]) captureBody.decided_by_username = String(args["decided-by-username"]);
    // Body convention: link to the prior in the markdown so the supersession
    // is also self-documented in prose.
    captureBody.body_md = `${captureBody.body_md ?? ""}\n\n## Supersedes\n\n- ${priorId}\n`.trim();

    const captureUrl = `${DOCO_BASE_URL}/by-id/${encodeURIComponent(docoId)}/api/decisions.json`;
    let captureResp: Response;
    try {
      captureResp = await fetch(captureUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(captureBody),
      });
    } catch (e) {
      console.error(cross(`Network error POSTing ${captureUrl}: ${(e as Error).message}`));
      process.exit(1);
    }
    if (!captureResp.ok) {
      const text = await captureResp.text();
      console.error(cross(`Capture failed (HTTP ${captureResp.status}): ${text}`));
      process.exit(1);
    }
    const captureJson = (await captureResp.json()) as {
      ok: boolean;
      id: string;
      footer_lines?: string[];
    };
    const newId = captureJson.id;
    if (Array.isArray(captureJson.footer_lines)) {
      for (const line of captureJson.footer_lines) console.log(line);
    }
    console.log(checkmark(`Captured new Decision: ${newId}`));

    const priorLifecycle = String(args["prior-lifecycle"] ?? "superseded");
    const patchUrl = `${DOCO_BASE_URL}/by-id/${encodeURIComponent(docoId)}/api/decisions/${priorId}.json`;
    let patchResp: Response;
    try {
      patchResp = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ lifecycle: priorLifecycle }),
      });
    } catch (e) {
      console.error(cross(`Network error PATCHing ${patchUrl}: ${(e as Error).message}`));
      console.error(c.warn(`  The new Decision ${newId} was captured but the prior was NOT marked as superseded. Retry: doco patch decision ${priorId} --lifecycle ${priorLifecycle}`));
      process.exit(1);
    }
    if (!patchResp.ok) {
      const text = await patchResp.text();
      console.error(cross(`PATCH on prior failed (HTTP ${patchResp.status}): ${text}`));
      console.error(c.warn(`  The new Decision ${newId} is in place. Retry the prior PATCH manually: doco patch decision ${priorId} --lifecycle ${priorLifecycle}`));
      process.exit(1);
    }
    const patchJson = (await patchResp.json()) as { footer_lines?: string[] };
    if (Array.isArray(patchJson.footer_lines)) {
      for (const line of patchJson.footer_lines) console.log(line);
    }
    console.log(checkmark(`Marked prior Decision ${priorId} as ${priorLifecycle}.`));
  },
});
