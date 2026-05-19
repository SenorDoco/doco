import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { c, checkmark, cross, header, rule } from "../output.js";

/**
 * `doco login` — Vercel-style browser-authorize flow
 * (decision_01KRKZM14WNA1685GN0F12WCKM).
 *
 * Posts to https://doco.to/api/v1/cli/device-init for a state nonce + short
 * code + authorize URL, opens the URL in the project owner's default
 * browser, then polls /api/v1/cli/device-exchange until the project
 * owner clicks Authorize. On approval, writes DOCO_ACCESS to ./.env
 * (gitignored secret) so the bootstrap hooks pick up the new
 * credentials on the next session.
 *
 * Replaces the host-bootstrap detour + /claim/<token> handoff: the Doco
 * is created directly under the authorizing project owner with no
 * intermediate "unclaimed" state.
 */
export const loginCmd = defineCommand({
  meta: {
    name: "login",
    description:
      "Authorize this CLI session in the browser (Vercel-style). Writes DOCO_ACCESS to ./.env on success.",
  },
  args: {
    host: {
      type: "string",
      description:
        "Doco host URL. Defaults to https://doco.to.",
    },
    create: {
      type: "string",
      description:
        "Optional Doco slug to create as part of authorization (lowercase kebab-case, no owner prefix — uses the authorizing user's username).",
    },
    "no-open": {
      type: "boolean",
      description:
        "Skip auto-opening the browser. Print the authorize URL instead.",
      default: false,
    },
    timeout: {
      type: "string",
      description: "Max seconds to wait for authorization (default 600 = 10 min).",
      default: "600",
    },
  },
  async run({ args }) {
    const envPath = resolve(process.cwd(), ".env");
    const env = readEnvFile(envPath);

    const docoHost =
      (typeof args.host === "string" ? args.host.trim() : "") ||
      "https://doco.to";
    const normalizedHost = docoHost.replace(/\/$/, "");

    const createSlug =
      typeof args.create === "string" && args.create.trim().length > 0
        ? args.create.trim().toLowerCase()
        : null;
    if (createSlug && !/^[a-z0-9][a-z0-9-]*[a-z0-9]?$/.test(createSlug)) {
      console.error(
        cross(`Invalid --create slug "${createSlug}". Use lowercase letters, digits, and hyphens.`),
      );
      process.exitCode = 2;
      return;
    }

    const timeoutSec = Math.max(60, Number(args.timeout) || 600);

    console.log(header("Doco — authorize CLI session"));
    console.log(rule());
    console.log(c.dim(`Host:     ${normalizedHost}`));
    console.log(c.dim(`Machine:  ${hostname()} (${process.platform})`));
    if (createSlug) console.log(c.dim(`Create:   ${createSlug}`));
    console.log();

    // 1. POST /api/v1/cli/device-init
    let init: {
      id: string;
      state_nonce: string;
      short_code: string;
      authorize_url: string;
      expires_at: string;
    };
    try {
      const res = await fetch(`${normalizedHost}/api/v1/cli/device-init`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": `doco-cli/${cliVersion()} (node ${process.version}; ${process.platform})`,
        },
        body: JSON.stringify({
          cli_version: cliVersion(),
          cli_hostname: hostname(),
        }),
      });
      if (!res.ok) {
        console.error(cross(`device-init failed: ${res.status} ${res.statusText}`));
        const body = await safeText(res);
        if (body) console.error(c.dim(body.slice(0, 500)));
        process.exitCode = 1;
        return;
      }
      init = (await res.json()) as typeof init;
    } catch (e) {
      console.error(cross(`device-init request failed: ${(e as Error).message}`));
      console.error(c.dim(`Check that ${normalizedHost} is reachable from this machine.`));
      process.exitCode = 1;
      return;
    }

    // The authorize_url has /cli/authorize?state=<nonce> — if the user
    // intends to create a Doco at the same step we pre-fill it.
    const authorizeUrl = (() => {
      if (!createSlug) return init.authorize_url;
      const u = new URL(init.authorize_url);
      u.searchParams.set("create", createSlug);
      return u.toString();
    })();

    console.log(checkmark(`Authorization initiated. Short code: ${c.warn(init.short_code)}`));
    console.log(c.dim(`Expires at ${init.expires_at}.`));
    console.log();
    if (args["no-open"]) {
      console.log("Open this URL in your browser to authorize:");
      console.log(`  ${c.dim(authorizeUrl)}`);
    } else {
      console.log(`Opening ${c.dim(authorizeUrl)} in your browser…`);
      openInBrowser(authorizeUrl).catch((e) => {
        console.error(c.dim(`(Auto-open failed: ${(e as Error).message}. Visit the URL above manually.)`));
      });
    }
    console.log();
    console.log(c.dim(`Waiting for approval (up to ${timeoutSec}s)…`));

    // 2. Poll /api/v1/cli/device-exchange
    const deadline = Date.now() + timeoutSec * 1000;
    let pollDelayMs = 1500;
    while (Date.now() < deadline) {
      await sleep(pollDelayMs);
      try {
        const res = await fetch(`${normalizedHost}/api/v1/cli/device-exchange`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state_nonce: init.state_nonce }),
        });
        if (res.status === 404) {
          console.error(cross("Authorization request not found (expired?). Run `doco login` again."));
          process.exitCode = 1;
          return;
        }
        const body = (await res.json()) as {
          status: string;
          token?: string;
          principal_id?: string;
          owner_username?: string;
          doco_handle?: string | null;
          doco_id?: string | null;
        };
        if (body.status === "approved" && body.token && body.owner_username) {
          console.log();
          console.log(checkmark(`Authorized by ${c.warn(body.owner_username)}.`));
          // DOCO_ACCESS is secret → .env (gitignored). The Doco
          // coordinate lives in DOCO.md.
          //
          // Migration: strip old credential names so .env has one
          // canonical Doco secret.
          const updates: Record<string, string> = { DOCO_ACCESS: body.token };
          const removeFromEnv: string[] = [];
          if (env.DOCO_TOKEN) removeFromEnv.push("DOCO_TOKEN");
          if (env.DOCO_KEY) removeFromEnv.push("DOCO_KEY");
          if (env.DOCO_URL) removeFromEnv.push("DOCO_URL");
          if (env.DOCO_ID) removeFromEnv.push("DOCO_ID");
          writeEnvFile(envPath, env, updates, removeFromEnv);
          console.log(
            checkmark(
              `Wrote DOCO_ACCESS to ${c.dim("./.env")}${
                removeFromEnv.length ? c.dim(" (removed legacy Doco env names)") : ""
              }.`,
            ),
          );

          if (body.doco_handle) {
            const docoUrl = `${normalizedHost}/${body.doco_handle}/`;
            writeFileSync(resolve(process.cwd(), "DOCO.md"), renderDocoMd(docoUrl), "utf8");
            console.log(checkmark(`Wrote Doco URL to ${c.dim("./DOCO.md")}.`));
          }

          // Install the agent-bootstrap files (AGENTS.md + CLAUDE.md shim +
          // .claude/settings.json + the four hook scripts) into the same
          // repo. The hooks themselves `source .env` on each fire and
          // pick up DOCO_ACCESS — once they're approved (Claude Code:
          // /hooks) the very next UserPromptSubmit picks up the fresh
          // credential (no full session restart needed).
          const idForInstall = body.doco_id || env.DOCO_ID || "";
          try {
            const { installAgentBootstrapCmd } = await import("./install-agent-bootstrap.js");
            const originalLog = console.log;
            console.log = () => {};
            try {
              await installAgentBootstrapCmd.run!({
                args: {
                  root: process.cwd(),
                  force: !!idForInstall, // re-stamp AGENTS.md when we have a fresh id
                  "doco-id": idForInstall,
                },
              } as never);
            } finally {
              console.log = originalLog;
            }
            console.log(
              checkmark(
                `Installed agent bootstrap (${c.dim("AGENTS.md + CLAUDE.md + .claude/")})${
                  idForInstall ? c.dim(` — stamped with ${idForInstall}`) : ""
                }.`,
              ),
            );
          } catch (e) {
            console.error(c.dim(`(install-agent-bootstrap failed: ${(e as Error).message}. Run \`doco install-agent-bootstrap\` manually.)`));
          }

          if (body.doco_handle) {
            console.log();
            console.log(c.dim(`Doco URL: ${normalizedHost}/${body.doco_handle}`));
          }
          console.log();
          console.log(c.dim("Next, in this Claude Code session (no restart needed):"));
          console.log(c.dim("  1. /hooks — review and approve the new SessionStart + UserPromptSubmit hooks."));
          console.log(c.dim("  2. /clear (optional) — fires SessionStart fresh so the canonical_instructions"));
          console.log(c.dim("     get injected. Without /clear, the per-prompt UserPromptSubmit hook still"));
          console.log(c.dim("     re-pushes the protocol checklist on the next user message."));
          console.log(c.dim("Other agents: AGENTS.md is now in place; restart per their convention if needed."));
          return;
        }
        if (body.status === "denied") {
          console.error(cross("Authorization denied in the browser. No changes made to ./.env."));
          process.exitCode = 1;
          return;
        }
        if (body.status === "expired") {
          console.error(cross("Authorization request expired. Run `doco login` again."));
          process.exitCode = 1;
          return;
        }
        if (body.status === "already_consumed") {
          console.error(cross("Authorization was already exchanged. Run `doco login` again."));
          process.exitCode = 1;
          return;
        }
        // status === "pending" — keep polling, with mild backoff.
        pollDelayMs = Math.min(pollDelayMs + 500, 4000);
      } catch (e) {
        // Transient network — don't bail, but slow down.
        console.error(c.dim(`(poll error: ${(e as Error).message} — retrying)`));
        pollDelayMs = Math.min(pollDelayMs + 1000, 8000);
      }
    }

    console.error(cross(`Timed out after ${timeoutSec}s. Run \`doco login\` again to retry.`));
    process.exitCode = 1;
  },
});

function cliVersion(): string {
  // Hard-coded matches package.json — keeps the CLI dependency-free.
  // Re-source from package.json once the package gets versioned.
  return "0.0.1";
}

function renderDocoMd(docoUrl: string): string {
  return `# Doco

This project is tracked in Doco for AI-native documentation: intents,
decisions, rules, actions, and history. Decisions and the why behind
them live at:

**${docoUrl}**

## For Contributors

Need access? Open the Doco URL above and sign in to mint an invite for
yourself. Or ask someone already connected to call:

\`\`\`sh
curl -X POST "${docoUrl.replace(/\/+$/, "")}/api/invites.json" \\
  -H "Authorization: Bearer $DOCO_ACCESS" \\
  -H "Content-Type: application/json" \\
  -d '{"expires_in_days": 7}'
\`\`\`

Agents should store their personal access credential in \`./.env\` as
\`DOCO_ACCESS=<64-hex>\`. The credential is secret and gitignored; this
file is the committed, non-secret project coordinate.
`;
}

async function safeText(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Open a URL in the default browser. Best-effort: macOS uses `open`,
 * Linux uses `xdg-open`, Windows uses `start`. We don't wait for the
 * process to exit — it fires off the OS handler and detaches.
 */
function openInBrowser(url: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const platform = process.platform;
    let cmd: string;
    let args: string[];
    if (platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (platform === "win32") {
      cmd = "cmd";
      args = ["/c", "start", "", url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    try {
      const child = spawn(cmd, args, {
        stdio: "ignore",
        detached: true,
      });
      child.on("error", reject);
      child.unref();
      // Give it a beat to spawn; OS handlers detach fast.
      setTimeout(resolveP, 200);
    } catch (e) {
      reject(e);
    }
  });
}

// ─── .env file helpers ────────────────────────────────────────────────

type EnvMap = Record<string, string>;

function readEnvFile(path: string): EnvMap {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const out: EnvMap = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip simple single/double quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Write the env file with `updates` applied and any keys in
 * `removeKeys` stripped. Preserves existing comments and ordering:
 * keys we update get rewritten in-place; new keys append at the bottom;
 * keys in `removeKeys` are deleted (along with their line); everything
 * else is untouched. `removeKeys` exists for one-time cleanup of old
 * Doco env names so .env converges on DOCO_ACCESS.
 */
function writeEnvFile(
  path: string,
  prior: EnvMap,
  updates: EnvMap,
  removeKeys: string[] = [],
): void {
  const existed = existsSync(path);
  const lines = existed ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const remove = new Set(removeKeys);
  const seen = new Set<string>();
  const filtered: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      filtered.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq < 0) {
      filtered.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (remove.has(key)) {
      // drop this line — migration path
      continue;
    }
    if (key in updates) {
      filtered.push(`${key}=${updates[key]}`);
      seen.add(key);
      continue;
    }
    filtered.push(line);
  }
  // Append keys that weren't present.
  if (filtered.length > 0 && filtered[filtered.length - 1]!.trim() !== "") {
    filtered.push("");
  }
  for (const [key, value] of Object.entries(updates)) {
    if (seen.has(key)) continue;
    filtered.push(`${key}=${value}`);
  }
  // Ensure trailing newline.
  let text = filtered.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  writeFileSync(path, text, "utf8");
  // Reflect into the in-memory map so callers can re-read.
  for (const [k, v] of Object.entries(updates)) prior[k] = v;
  for (const k of removeKeys) delete prior[k];
}
