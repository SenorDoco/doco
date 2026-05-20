import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { requireDocoConfig } from "../env.js";
import { c, cross } from "../output.js";

/**
 * `doco patch <type> <id>` — extend an existing Doco node via PATCH.
 *
 * The single biggest unlock against capture-skip rationalization
 * (ADR-141): when a search hit at vector_score > ~0.45 names the file
 * or territory you're editing, the right move is to PATCH that
 * Decision, not skip-and-rationalize or open a sibling. This command
 * makes the PATCH cost equal to the POST cost.
 *
 * Wraps the existing
 *   PATCH /<doco-handle>/api/<plural>/<id>.json
 * endpoints. Same auth + response shape as `doco capture`.
 */

// Host comes from requireDocoConfig() so DOCO_HOST overrides for local dev.

const PLURAL_BY_TYPE: Record<string, string> = {
  decision: "decisions",
  intent: "intents",
  action: "actions",
  rule: "rules",
  reference: "references",
};

function splitList(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function readBody(inline: string | undefined, fromFile: string | undefined): string | undefined {
  if (inline && fromFile) {
    console.error(cross("Pass only one of the inline + -file variants for the same body field."));
    process.exit(2);
  }
  if (fromFile) return readFileSync(resolve(process.cwd(), fromFile), "utf8");
  return inline;
}

function inferPluralFromId(id: string): string | null {
  const m = id.match(/^([a-z_]+)_/);
  if (!m) return null;
  const type = m[1].replace(/_$/, "");
  return PLURAL_BY_TYPE[type] ?? null;
}

async function sendPatch(type: string, id: string, body: Record<string, unknown>): Promise<void> {
  const plural = PLURAL_BY_TYPE[type];
  if (!plural) {
    console.error(
      cross(`Unknown type '${type}'. Pass one of: ${Object.keys(PLURAL_BY_TYPE).join(", ")}.`),
    );
    process.exit(2);
  }

  // If the id's prefix disagrees with --type, that's almost certainly user error.
  const inferred = inferPluralFromId(id);
  if (inferred && inferred !== plural) {
    console.error(
      cross(
        `Id '${id}' looks like a ${inferred.slice(0, -1)} but --type is ${type}. Double-check the id.`,
      ),
    );
    process.exit(2);
  }

  if (Object.keys(body).length === 0) {
    console.error(
      cross(
        "Nothing to patch. Pass at least one of: --append-body / --body / --summary / --purpose / --lifecycle / --superseded-by / --add-intent / --remove-intent.",
      ),
    );
    process.exit(2);
  }

  const { access, docoRef, host } = requireDocoConfig();
  const url = `${host}/${encodeURIComponent(docoRef)}/api/${plural}/${id}.json`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${access}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(cross(`Network error PATCHing ${url}: ${(e as Error).message}`));
    process.exit(1);
  }
  const text = await resp.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!resp.ok) {
    const errObj =
      parsed && typeof parsed === "object" && parsed !== null
        ? (parsed as { error?: unknown; hint?: unknown; rejected?: unknown })
        : null;
    const errMsg = errObj && "error" in errObj ? String(errObj.error) : text;
    console.error(cross(`HTTP ${resp.status}: ${errMsg}`));
    // Mutability gate (decision_01KRKEPRAMM9QSSEJ2X5FHPESJ) emits 409 with
    // a `hint` pointing at the supersession affordance. Print it so the
    // operator sees the next-step suggestion alongside the error.
    if (resp.status === 409 && errObj && typeof errObj.hint === "string") {
      console.error(`  hint: ${errObj.hint}`);
    }
    process.exit(1);
  }
  const obj = (parsed ?? {}) as { footer_lines?: string[] };
  if (Array.isArray(obj.footer_lines) && obj.footer_lines.length > 0) {
    for (const line of obj.footer_lines) console.log(line);
  } else {
    console.log(text);
  }
}

function buildPatchBody(_type: string, args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  const appendBody = readBody(
    args["append-body"] as string | undefined,
    args["append-body-file"] as string | undefined,
  );
  if (appendBody !== undefined) body.body_md_append = appendBody;

  // --body / --body-file replaces the whole body; the canonical
  // recommends --append-body for the typical "extend existing rationale"
  // case, but a replace is sometimes the right move.
  const replaceBody = readBody(
    args["body"] as string | undefined,
    args["body-file"] as string | undefined,
  );
  if (replaceBody !== undefined) body.body_md = replaceBody;

  if (args.summary) {
    body.summary = args.summary;
  }
  if (args.purpose) body.purpose = args.purpose;
  if (args.lifecycle) body.lifecycle = args.lifecycle;
  if (args["superseded-by"] !== undefined) body.superseded_by = args["superseded-by"];

  const addIntents = splitList(args["add-intent"] as string | undefined);
  if (addIntents.length) body.intent_ids_add = addIntents;
  const removeIntents = splitList(args["remove-intent"] as string | undefined);
  if (removeIntents.length) body.intent_ids_remove = removeIntents;

  return body;
}

const commonArgs = {
  "append-body": {
    type: "string" as const,
    description:
      "Append a paragraph to the entity's markdown body (the primary use case — keeps the entity's rationale chronologically extended).",
  },
  "append-body-file": {
    type: "string" as const,
    description: "Path to a file whose contents are appended to body_md.",
  },
  body: {
    type: "string" as const,
    description:
      "REPLACE the entity's markdown body entirely (rare — usually --append-body is right).",
  },
  "body-file": {
    type: "string" as const,
    description: "Path to a file whose contents REPLACE body_md.",
  },
  summary: {
    type: "string" as const,
    description: "Replace the entity's one-line summary.",
  },
  purpose: {
    type: "string" as const,
    description: "Replace the entity's purpose (legacy — ignored after v16; use --summary).",
  },
  lifecycle: {
    type: "string" as const,
    description: "Set lifecycle (e.g. 'active', 'superseded', 'abandoned', 'failed').",
  },
  "superseded-by": {
    type: "string" as const,
    description:
      "Record the supersession edge: id of the entity that replaces this one. Allowed on frozen claims (per the mutability gate). Pair with --lifecycle superseded for the full supersession transition.",
  },
  "add-intent": {
    type: "string" as const,
    description: "Comma-separated intent ids to add (e.g. 'intent_01KR…,intent_01KS…').",
  },
  "remove-intent": {
    type: "string" as const,
    description: "Comma-separated intent ids to remove.",
  },
};

function makeTypedSubcommand(type: string) {
  return defineCommand({
    meta: {
      name: type,
      description: `PATCH a ${type} (PATCH /<doco-handle>/api/${PLURAL_BY_TYPE[type]}/<id>.json).`,
    },
    args: {
      id: {
        type: "positional" as const,
        description: `The ${type}'s ULID (e.g. '${type}_01KR…').`,
        required: true,
      },
      ...commonArgs,
    },
    async run({ args }) {
      const id = String(args.id);
      const body = buildPatchBody(type, args as Record<string, unknown>);
      await sendPatch(type, id, body);
    },
  });
}

export const patchCmd = defineCommand({
  meta: {
    name: "patch",
    description:
      "Extend an existing Doco node via PATCH. Use this when a search hit names the file or territory you're editing (vector_score > ~0.45) — it's strictly preferred over opening a sibling node. Reads DOCO_ACCESS from env or ./.env and the Doco URL from DOCO.md. Prints the response's footer_lines to stdout.",
  },
  subCommands: {
    decision: makeTypedSubcommand("decision"),
    intent: makeTypedSubcommand("intent"),
    action: makeTypedSubcommand("action"),
    rule: makeTypedSubcommand("rule"),
    reference: makeTypedSubcommand("reference"),
  },
});

void c;
