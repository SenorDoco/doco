import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import {
  type EntityId,
  generateUlid,
  makeEntityId,
  nowIso,
} from "@doco/shared";
import { c, checkmark, cross, header, rule } from "../output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// templates/ lives at the package root: ../../templates from src/commands/ or dist/commands/.
const TEMPLATES_DIR = resolve(__dirname, "..", "..", "templates");

export const initCmd = defineCommand({
  meta: {
    name: "init",
    description: "Create a new Doco at <slug> (under the current directory).",
  },
  args: {
    slug: {
      type: "positional",
      description: "Slug for the new Doco, e.g. 'torrenegra/my-project'.",
      required: true,
    },
    "owner-username": {
      type: "string",
      description: "GitHub username of the owner (creates a stub Principal).",
      required: true,
    },
    "owner-email": {
      type: "string",
      description: "Email for the owner Principal (optional).",
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
    const ownerUsername = args["owner-username"] as string;
    const ownerEmail = args["owner-email"] as string | undefined;
    const visibility = args.visibility as "private" | "public";
    const existing = args.existing as boolean;

    if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/.test(slug)) {
      console.error(
        cross(`Invalid slug "${slug}". Expected '<owner>/<name>' with kebab-case parts.`),
      );
      process.exitCode = 2;
      return;
    }

    const dirName = slug.split("/")[1] ?? slug;
    const root = resolve(process.cwd(), dirName);

    // Generate ULIDs.
    const docoUlid = generateUlid();
    const principalUlid = generateUlid();
    const docoId = makeEntityId("doco", docoUlid) as EntityId<"doco">;
    const principalId = makeEntityId("principal", principalUlid) as EntityId<"principal">;

    const created = nowIso();

    // Build the directory layout.
    await mkdir(root, { recursive: true });
    for (const sub of [
      "schema",
      "principals",
      "intents",
      "rules",
      "decisions",
      "actions",
      "reasoning",
      "references",
      "tags",
      "evaluations",
    ]) {
      await mkdir(join(root, sub), { recursive: true });
    }

    // Copy schema/glossary templates.
    await copyFile(join(TEMPLATES_DIR, "doco.schema.json"), join(root, "schema", "doco.schema.json"));
    await copyFile(join(TEMPLATES_DIR, "glossary.yaml"), join(root, "glossary.yaml"));

    // Write doco.yaml.
    const docoYaml = `# Doco — root identity. See https://doco.to (eventually) for docs.
id: ${docoId}
node_type: doco
schema_version: "0.1"

slug: ${slug}
display_name: ${slug.split("/")[1] ?? slug}
visibility: ${visibility}
default_branch: main

owner_id: ${principalId}

description: |
  ${existing ? "An Doco for an existing project (brownfield)." : "An Doco for a new project."}

summary: "Created by 'doco init' on ${created}."
created_at: ${created}
created_by: ${principalId}
revision: 1
lifecycle: active
status: active
tags: []

members:
  - principal_id: ${principalId}
    role: owner
    permissions: [read, write, execute, admin]

imports: []
`;
    await writeFile(join(root, "doco.yaml"), docoYaml, "utf8");

    // Write the owner Principal stub.
    const githubBlock = ownerEmail
      ? `github_identity:\n  github_login: ${ownerUsername}\n  email: ${ownerEmail}\n`
      : `github_identity:\n  github_login: ${ownerUsername}\n`;
    const principalYaml = `id: ${principalId}
doco_id: ${docoId}
node_type: principal
schema_version: "0.1"
summary: "Owner of ${slug}."

type: human
username: ${ownerUsername}
display_name: ${ownerUsername}

${githubBlock}
created_at: ${created}
created_by: ${principalId}   # self-reference: bootstrap principal
revision: 1
lifecycle: active
status: active
tags: []
`;
    await writeFile(
      join(root, "principals", `${principalId}.yaml`),
      principalYaml,
      "utf8",
    );

    // Write a minimal .gitignore.
    await writeFile(
      join(root, ".gitignore"),
      `# Local index cache — per-clone, regenerable.\n.doco/\n\n# OS / editor\n.DS_Store\n*.swp\n.vscode/\n.idea/\n`,
      "utf8",
    );

    // Write a stub README.
    await writeFile(
      join(root, "README.md"),
      `# ${slug.split("/")[1] ?? slug}\n\nAn Doco.\n\nNext steps:\n\n1. Declare your top-level Intents.\n2. Add the first few \`must\`/\`must_not\` Rules (privacy, security, compliance).\n3. Record Decisions as work begins.\n\nRun \`doco validate\` to confirm the structure is correct.\n`,
      "utf8",
    );

    console.log();
    console.log(header(`Created Doco: ${slug}`));
    console.log(rule());
    console.log(checkmark(`Root:           ${c.dim(root)}`));
    console.log(checkmark(`Doco ID:       ${c.dim(docoId)}`));
    console.log(checkmark(`Owner:          ${ownerUsername} (${principalId})`));
    if (existing) {
      console.log(checkmark(`Mode:           ${c.warn("brownfield")} (extend with backfill importers in phase 6)`));
    }
    console.log();
    console.log(c.dim(`Next: cd ${dirName} && doco validate`));
    console.log();
  },
});
