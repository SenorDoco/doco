import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineCommand } from "citty";
import { readDocoRefFromProject } from "../env.js";
import { findTemplatesDir } from "../find-templates.js";
import { c, checkmark, cross, header, rule } from "../output.js";

/**
 * AGENTS.md / CLAUDE.md placeholder substituted with the project's
 * Legacy placeholder support for older template builds. Current
 * templates read the Doco coordinate from DOCO.md instead.
 */
const DOCO_ID_PLACEHOLDER = /__DOCO_ID__/g;

/**
 * `doco install-agent-bootstrap` — drop the agent bootstrap files into a
 * repo so any AI agent (via the cross-agent `AGENTS.md` convention, or
 * via Claude Code's auto-loaded CLAUDE.md + SessionStart +
 * UserPromptSubmit hooks) is forced to run `doco bootstrap` before
 * responding.
 *
 * Files installed at the repo root (the cwd, or --root):
 *
 *   AGENTS.md                       (canonical bootstrap — read by any
 *                                    agent following the AGENTS.md spec)
 *   CLAUDE.md                       (one-line shim: `@./AGENTS.md` — only
 *                                    exists because Claude Code auto-loads
 *                                    CLAUDE.md by name, not AGENTS.md)
 *   DOCO.md                         (committed, non-secret Doco URL)
 *   .claude/settings.json           (SessionStart + UserPromptSubmit + PostToolUse + Stop hooks)
 *   .claude/bootstrap-fetch.sh      (SessionStart hook script)
 *   .claude/user-prompt-fetch.sh    (UserPromptSubmit hook script)
 *   .claude/post-tool-use-check.sh  (PostToolUse hook — path-match nudge per ADR-141)
 *   .claude/stop-check.sh           (Stop hook — edits-without-captures nudge per ADR-141)
 *   .agents/doco-agent-client.mjs   (dependency-free Node fetch helper; keeps
 *                                    DOCO_ACCESS out of shell command text)
 *
 * Source of truth: `packages/cli/templates/agent-bootstrap/`. Edits there
 * propagate to every Doco that runs this command (or `doco init`, which
 * runs it automatically).
 *
 * Non-Claude agents read AGENTS.md directly (the convention any modern
 * coding agent honors) and additionally run `doco bootstrap` at the start
 * of each task to get the live canonical_instructions. The `.claude/`
 * hooks are Claude-Code-specific and have no equivalent for other agents.
 */
const __dirname = dirname(fileURLToPath(import.meta.url));
// Walk up from this file's directory until templates/ is found. Works
// from dist/commands/ (tsc layout) AND dist/ (bundled layout).
const TEMPLATES_DIR = findTemplatesDir(__dirname, "agent-bootstrap");

export const installAgentBootstrapCmd = defineCommand({
  meta: {
    name: "install-agent-bootstrap",
    description:
      "Install agent bootstrap files (AGENTS.md + CLAUDE.md shim, .claude/settings.json, hook scripts).",
  },
  args: {
    root: {
      type: "string",
      description: "Target repo root (default: current working directory).",
    },
    force: {
      type: "boolean",
      description: "Overwrite existing files. Default: skip and warn.",
      default: false,
    },
    "doco-id": {
      type: "string",
      description:
        "Legacy Doco ref to stamp if an older template contains a placeholder. Current templates read DOCO.md.",
    },
  },
  async run({ args }) {
    const target = resolve((args.root as string | undefined) ?? process.cwd());
    if (!existsSync(target)) {
      console.error(cross(`Target directory does not exist: ${target}`));
      process.exitCode = 2;
      return;
    }
    const force = args.force as boolean;
    // Resolve the legacy Doco ref to substitute: explicit arg > env >
    // existing project files. Empty string
    // when none is known — the template keeps the literal placeholder
    // so the project owner can see what's missing.
    const docoIdArg = (args["doco-id"] as string | undefined)?.trim();
    const docoId = docoIdArg || process.env.DOCO_ID || readDocoRefFromProject(target) || "";

    const agentsMdSrc = join(TEMPLATES_DIR, "AGENTS.md");
    const claudeMdSrc = join(TEMPLATES_DIR, "CLAUDE.md");
    // v13: the pointer file moved from `DOCO.md` to `.doco/connections.md`
    // (decision_01KS3DX190V93NGR3QQ37J8TVQ).
    const connectionsMdSrc = join(TEMPLATES_DIR, ".doco", "connections.md");
    const envExampleSrc = join(TEMPLATES_DIR, ".env.example");
    const settingsSrc = join(TEMPLATES_DIR, ".claude", "settings.json");
    const hookSrc = join(TEMPLATES_DIR, ".claude", "bootstrap-fetch.sh");
    const userPromptHookSrc = join(TEMPLATES_DIR, ".claude", "user-prompt-fetch.sh");
    const postToolUseHookSrc = join(TEMPLATES_DIR, ".claude", "post-tool-use-check.sh");
    const stopHookSrc = join(TEMPLATES_DIR, ".claude", "stop-check.sh");
    const agentClientSrc = join(TEMPLATES_DIR, ".agents", "doco-agent-client.mjs");
    for (const p of [
      agentsMdSrc,
      claudeMdSrc,
      connectionsMdSrc,
      envExampleSrc,
      settingsSrc,
      hookSrc,
      userPromptHookSrc,
      postToolUseHookSrc,
      stopHookSrc,
      agentClientSrc,
    ]) {
      if (!existsSync(p)) {
        console.error(cross(`Template missing: ${p}. Reinstall doco-cli.`));
        process.exitCode = 2;
        return;
      }
    }

    const agentsMdDst = join(target, "AGENTS.md");
    const claudeMdDst = join(target, "CLAUDE.md");
    const connectionsMdDst = join(target, ".doco", "connections.md");
    const envExampleDst = join(target, ".env.example");
    const claudeDir = join(target, ".claude");
    const settingsDst = join(claudeDir, "settings.json");
    const hookDst = join(claudeDir, "bootstrap-fetch.sh");
    const userPromptHookDst = join(claudeDir, "user-prompt-fetch.sh");
    const postToolUseHookDst = join(claudeDir, "post-tool-use-check.sh");
    const stopHookDst = join(claudeDir, "stop-check.sh");
    const agentsDir = join(target, ".agents");
    const agentClientDst = join(agentsDir, "doco-agent-client.mjs");

    const actions: string[] = [];

    // AGENTS.md (canonical) + CLAUDE.md (one-line shim) — write/skip.
    // Substitute __DOCO_ID__ in legacy rendered output. When docoId is empty
    // we leave the literal placeholder alone so the project owner can
    // spot what's missing and re-run `doco login`.
    for (const [src, dst, label] of [
      [agentsMdSrc, agentsMdDst, "AGENTS.md"],
      [claudeMdSrc, claudeMdDst, "CLAUDE.md"],
    ] as const) {
      const tplRaw = readFileSync(src, "utf8");
      const fromTpl = docoId ? tplRaw.replace(DOCO_ID_PLACEHOLDER, docoId) : tplRaw;
      if (existsSync(dst) && !force) {
        const onDisk = readFileSync(dst, "utf8");
        if (onDisk === fromTpl) {
          actions.push(`${c.dim("=")} ${c.dim(`${label} (already at template version)`)}`);
        } else {
          actions.push(
            `${c.warn("!")} ${label} exists and differs from template — re-run with --force to overwrite.`,
          );
        }
      } else {
        writeFileSync(dst, fromTpl, "utf8");
        actions.push(checkmark(`${label} ${force ? "(overwritten)" : "written"}`));
      }
    }

    // .doco/connections.md — committed, non-secret project coordinate.
    // v13 replaces the legacy DOCO.md. If the CLI login flow has a
    // concrete URL it writes this before invoking the installer, so
    // don't overwrite it here.
    {
      const label = ".doco/connections.md";
      if (existsSync(connectionsMdDst)) {
        actions.push(`${c.dim("=")} ${c.dim(`${label} (existing — not overwritten)`)}`);
      } else {
        const dotDoco = join(target, ".doco");
        if (!existsSync(dotDoco)) mkdirSync(dotDoco, { recursive: true });
        copyFileSync(connectionsMdSrc, connectionsMdDst);
        actions.push(checkmark(`${label} written`));
      }
    }

    // .env.example — user-owned data. Write on first install (when missing)
    // but NEVER overwrite, even with --force. Same filename can serve
    // different purposes in different repos (meta-Doco runs the host and
    // needs its own host-specific env vars), and the file may carry
    // hand-added entries the user depends on. The bootstrap-mechanism files
    // below are the framework's source of truth; .env.example is the
    // adopter's. To reset .env.example, delete it manually and re-run.
    {
      const label = envExampleDst.replace(`${target}/`, "");
      if (existsSync(envExampleDst)) {
        actions.push(
          `${c.dim("=")} ${c.dim(`${label} (existing — not overwritten; rm and re-run to reset)`)}`,
        );
      } else {
        copyFileSync(envExampleSrc, envExampleDst);
        actions.push(checkmark(`${label} written`));
      }
    }

    // .claude/settings.json + hook scripts — bootstrap mechanism. --force
    // overwrites; without --force, exists-and-differs prints a warning so
    // the operator can review the drift before re-syncing.
    if (!existsSync(claudeDir)) mkdirSync(claudeDir, { recursive: true });
    if (!existsSync(agentsDir)) mkdirSync(agentsDir, { recursive: true });

    for (const [src, dst, mode] of [
      [settingsSrc, settingsDst, 0o644],
      [hookSrc, hookDst, 0o755],
      [userPromptHookSrc, userPromptHookDst, 0o755],
      [postToolUseHookSrc, postToolUseHookDst, 0o755],
      [stopHookSrc, stopHookDst, 0o755],
      [agentClientSrc, agentClientDst, 0o755],
    ] as const) {
      const label = dst.replace(`${target}/`, "");
      if (existsSync(dst) && !force) {
        const onDisk = readFileSync(dst, "utf8");
        const fromTpl = readFileSync(src, "utf8");
        if (onDisk === fromTpl) {
          actions.push(`${c.dim("=")} ${c.dim(`${label} (already at template version)`)}`);
        } else {
          actions.push(
            `${c.warn("!")} ${label} exists and differs from template — re-run with --force to overwrite.`,
          );
        }
      } else {
        copyFileSync(src, dst);
        chmodSync(dst, mode);
        actions.push(checkmark(`${label} ${force ? "(overwritten)" : "written"}`));
      }
    }

    console.log();
    console.log(header(`Doco agent bootstrap installed at ${target}`));
    console.log(rule());
    for (const a of actions) console.log(a);
    console.log(rule());
    console.log(c.dim("Next:"));
    if (!docoId) {
      console.log(c.dim("  1. Run `doco login --host https://doco.to` to authorize, or edit DOCO.md with the Doco URL."));
    } else {
      console.log(
        c.dim(
          `  1. Project Doco ref found: ${docoId}. To rotate access, re-run \`doco login\`.`,
        ),
      );
    }
    console.log(c.dim("  2. cp .env.example .env  # fill in DOCO_ACCESS (mint via `doco login`)"));
    console.log(c.dim("  3. Restart your Claude Code session in this directory."));
    console.log(
      c.dim(
        "  4. In Claude Code, run /hooks → approve the SessionStart + UserPromptSubmit + PostToolUse + Stop hooks. Claude Code skips unapproved project hooks silently, so the protocol won't auto-load until you approve them once per project (and once per worktree if you use them).",
      ),
    );
    console.log(
      c.dim(
        "  5. Non-Claude agents: run `node .agents/doco-agent-client.mjs bootstrap` manually at the start of each task. It reads DOCO_ACCESS from ./.env without exposing the credential in the shell command.",
      ),
    );
    console.log();
  },
});
