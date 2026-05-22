// `doco supersede <id>` — convenience for the supersession workflow
// (decision_01KRKEPRAMM9QSSEJ2X5FHPESJ).
//
// Two-step under the hood:
//   1. POST /<doco-handle>/api/decisions.json — capture a new Decision
//                                                  that supersedes the prior.
//   2. PATCH /<doco-handle>/api/decisions/<prior>.json — set lifecycle to
//                                                           "retired" and
//                                                           superseded_by to
//                                                           the new Decision.
//
// Today only Decisions are supported (the most common case). Intent,
// Rule, Action supersession would mirror this — followup if needed.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { c, cross, checkmark } from "../output.js";
import { requireDocoConfig } from "../env.js";

// Host comes from requireDocoConfig() so DOCO_HOST overrides for local dev.

export const supersedeCmd = defineCommand({
  meta: {
    name: "supersede",
    description:
      "Capture a new Decision that supersedes the prior, then retire the prior with a superseded_by synapse.",
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

    const { access, docoRef, host } = requireDocoConfig();

    const captureBody: Record<string, unknown> = {
      question: String(args.question ?? `Supersede ${priorId} — what changes?`),
      chosen,
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

    const captureUrl = `${host}/${encodeURIComponent(docoRef)}/api/decisions.json`;
    let captureResp: Response;
    try {
      captureResp = await fetch(captureUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
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

    const patchUrl = `${host}/${encodeURIComponent(docoRef)}/api/decisions/${priorId}.json`;
    let patchResp: Response;
    try {
      patchResp = await fetch(patchUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
        body: JSON.stringify({ lifecycle: "retired", superseded_by: newId }),
      });
    } catch (e) {
      console.error(cross(`Network error PATCHing ${patchUrl}: ${(e as Error).message}`));
      console.error(c.warn(`  The new Decision ${newId} was captured but the prior was NOT retired. Retry: doco patch decision ${priorId} --lifecycle retired --superseded-by ${newId}`));
      process.exit(1);
    }
    if (!patchResp.ok) {
      const text = await patchResp.text();
      console.error(cross(`PATCH on prior failed (HTTP ${patchResp.status}): ${text}`));
      console.error(c.warn(`  The new Decision ${newId} is in place. Retry the prior PATCH manually: doco patch decision ${priorId} --lifecycle retired --superseded-by ${newId}`));
      process.exit(1);
    }
    const patchJson = (await patchResp.json()) as { footer_lines?: string[] };
    if (Array.isArray(patchJson.footer_lines)) {
      for (const line of patchJson.footer_lines) console.log(line);
    }
    console.log(checkmark(`Retired prior Decision ${priorId} with superseded_by ${newId}.`));
  },
});
