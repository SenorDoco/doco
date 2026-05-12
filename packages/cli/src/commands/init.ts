import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import { type EntityId, generateUlid, makeEntityId, nowIso } from "@doco/shared";
import { c, checkmark, cross, header, rule } from "../output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "..", "..", "templates");

/**
 * `doco init <slug> [--actor <name>] [--visibility private|public]`
 *
 * Creates a new local-solo Doco. Per ADR-087, no Principal entity is
 * created — actor identity is a free-form string. The optional `--actor`
 * flag stamps `created_by` on doco.yaml; defaults to "anonymous" if absent.
 */
export const initCmd = defineCommand({
  meta: {
    name: "init",
    description: "Create a new local-solo Doco at <slug> (under the current directory).",
  },
  args: {
    slug: {
      type: "positional",
      description: "Slug for the new Doco. Single segment (e.g. 'my-project').",
      required: true,
    },
    actor: {
      type: "string",
      description: "Free-form actor string stamped on created_by (e.g., 'torrenegra').",
      default: "anonymous",
    },
    visibility: {
      type: "string",
      description: "private | public",
      default: "private",
    },
    existing: {
      type: "boolean",
      description: "Mark this Doco as one created for an existing project (brownfield).",
      default: false,
    },
  },
  async run({ args }) {
    const slug = args.slug as string;
    const actor = args.actor as string;
    const visibility = args.visibility as "private" | "public";
    const existing = args.existing as boolean;

    if (!/^[a-z0-9_-]+$/.test(slug)) {
      console.error(cross(`Invalid slug "${slug}". Expected kebab-case (e.g. 'my-project').`));
      process.exitCode = 2;
      return;
    }

    const root = resolve(process.cwd(), slug);
    const docoUlid = generateUlid();
    const docoId = makeEntityId("doco", docoUlid) as EntityId<"doco">;

    const created = nowIso();

    await mkdir(root, { recursive: true });
    for (const sub of [
      "schema",
      "intents",
      "ideas",
      "rules",
      "decisions",
      "actions",
      "reasoning",
      "references",
      "scopes",
      "evaluations",
    ]) {
      await mkdir(join(root, sub), { recursive: true });
    }

    await copyFile(join(TEMPLATES_DIR, "doco.schema.json"), join(root, "schema", "doco.schema.json"));
    await copyFile(join(TEMPLATES_DIR, "glossary.yaml"), join(root, "glossary.yaml"));

    const docoYaml = `# Doco — root identity. Local-solo shape (ADR-087).
id: ${docoId}
node_type: doco
schema_version: "0.2"

slug: ${slug}
display_name: ${slug}
visibility: ${visibility}
default_branch: main

description: |
  ${existing ? "A Doco for an existing project (brownfield)." : "A Doco for a new project."}

summary: "Created by 'doco init' on ${created}."
created_at: ${created}
created_by: ${actor}
revision: 1
lifecycle: active
status: active
scopes: []
`;
    await writeFile(join(root, "doco.yaml"), docoYaml, "utf8");

    await writeFile(
      join(root, ".gitignore"),
      `# Local index cache — per-clone, regenerable.\n.doco/\n\n# OS / editor\n.DS_Store\n*.swp\n.vscode/\n.idea/\n`,
      "utf8",
    );

    await writeFile(
      join(root, "README.md"),
      `# ${slug}\n\nA Doco.\n\nNext steps:\n\n1. Declare your top-level Intents.\n2. Add the first few \`must\`/\`must_not\` Rules (privacy, security, compliance).\n3. Record Decisions as work begins.\n\nRun \`doco validate\` to confirm the structure is correct.\n`,
      "utf8",
    );

    console.log();
    console.log(header(`Created Doco: ${slug}`));
    console.log(rule());
    console.log(checkmark(`Root:    ${c.dim(root)}`));
    console.log(checkmark(`Doco ID: ${c.dim(docoId)}`));
    console.log(checkmark(`Actor:   ${actor}`));
    if (existing) {
      console.log(
        checkmark(`Mode:    ${c.warn("brownfield")} (extend with backfill importers later)`),
      );
    }
    console.log();
    console.log(c.dim(`Next: cd ${slug} && doco validate`));
    console.log();
  },
});
