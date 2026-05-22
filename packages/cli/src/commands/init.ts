import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type EntityId, generateUlid, makeEntityId, nowIso } from "@doco/shared";
import { defineCommand } from "citty";
import { findTemplatesDir } from "../find-templates.js";
import { c, checkmark, cross, header, rule } from "../output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Walk up from this file's directory until templates/ is found. Works
// from dist/commands/ (tsc layout) AND dist/ (bundled layout).
const TEMPLATES_DIR = findTemplatesDir(__dirname);

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
      "principals",
      "intents",
      "rules",
      "decisions",
      "actions",
      "references",
    ]) {
      await mkdir(join(root, sub), { recursive: true });
    }

    // Copy glossary template.
    await copyFile(join(TEMPLATES_DIR, "glossary.yaml"), join(root, "glossary.yaml"));

    // Write doco.yaml.
    const docoYaml = `# Doco — root identity. See https://doco.to (eventually) for docs.
id: ${docoId}
entity_type: doco

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
lifecycle: active
tags: []

members:
  - collaborator_id: ${principalId}
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
entity_type: principal
summary: "Owner of ${slug}."

type: person
username: ${ownerUsername}

${githubBlock}
created_at: ${created}
created_by: ${principalId}   # self-reference: bootstrap principal
lifecycle: active
tags: []
`;
    await writeFile(join(root, "principals", `${principalId}.yaml`), principalYaml, "utf8");

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

    // Drop the agent bootstrap files (AGENTS.md + CLAUDE.md shim +
    // .claude/settings.json + hooks + .agents/doco-agent-client.mjs)
    // so any agent that walks
    // into this repo — Claude Code via CLAUDE.md, others via the
    // AGENTS.md convention — is forced to fetch the canonical
    // instructions before responding. Legacy templates accepted a
    // `doco-id`; current templates read the public Doco URL from
    // DOCO.md and the secret credential from DOCO_ACCESS.
    const { installAgentBootstrapCmd } = await import("./install-agent-bootstrap.js");
    // Run silently — captured output muddles `doco init`'s own success block.
    // The user sees the bootstrap files in the directory listing afterwards.
    const originalLog = console.log;
    console.log = () => {};
    try {
      await installAgentBootstrapCmd.run!({
        args: { root, force: false, "doco-id": docoId },
      } as never);
    } finally {
      console.log = originalLog;
    }

    console.log();
    console.log(header(`Created Doco: ${slug}`));
    console.log(rule());
    console.log(checkmark(`Root:           ${c.dim(root)}`));
    console.log(checkmark(`Doco ID:       ${c.dim(docoId)}`));
    console.log(checkmark(`Owner:          ${ownerUsername} (${principalId})`));
    if (existing) {
      console.log(
        checkmark(
          `Mode:           ${c.warn("brownfield")} (extend with backfill importers in phase 6)`,
        ),
      );
    }
    console.log(
      checkmark(
        `Agent bootstrap installed (AGENTS.md + CLAUDE.md shim + .claude/ + .agents/ + .env.example)`,
      ),
    );
    console.log();
    console.log(c.dim("Next:"));
    console.log(c.dim(`  1. cd ${dirName}`));
    console.log(c.dim(`  2. cp .env.example .env  # fill in DOCO_ACCESS`));
    console.log(c.dim(`  3. doco validate  # confirm structure`));
    console.log(c.dim(`  4. Restart your Claude Code session in this directory.`));
    console.log(
      c.dim(
        `  5. In Claude Code, run /hooks → approve the SessionStart + UserPromptSubmit hooks. Claude Code skips unapproved project hooks silently, so the protocol won't auto-load until you approve them once per project (and once per worktree if you use them).`,
      ),
    );
    console.log();
  },
});
