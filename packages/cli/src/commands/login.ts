import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { defineCommand } from "citty";
import { readDocoRefFromProject } from "../env.js";
import { c, checkmark, cross, header, rule } from "../output.js";

/**
 * `doco login` — OAuth Device Authorization Grant for shell-capable
 * agents that can open a browser but want a credential written back to
 * the repo-local `.env`.
 *
 * Flow:
 *   1. Register a public OAuth client with the host.
 *   2. Start RFC 8628 device authorization.
 *   3. Open /device?user_code=... for the user.
 *   4. Poll /oauth/token until the user approves.
 *   5. Store DOCO_ACCESS / DOCO_REFRESH / DOCO_CLIENT_ID / DOCO_HOST in ./.env.
 */
export const loginCmd = defineCommand({
  meta: {
    name: "login",
    description:
      "Authorize this CLI session with OAuth device flow. Writes Doco OAuth credentials to ./.env on success.",
  },
  args: {
    host: {
      type: "string",
      description: "Doco host URL. Defaults to https://doco.to.",
    },
    "no-open": {
      type: "boolean",
      description: "Skip auto-opening the browser. Print the authorize URL instead.",
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

    const docoHost = (typeof args.host === "string" ? args.host.trim() : "") || "https://doco.to";
    const normalizedHost = docoHost.replace(/\/$/, "");

    const timeoutSec = Math.max(60, Number(args.timeout) || 600);
    const targetDocoHandle = readTargetDocoHandle();

    console.log(header("Doco — authorize CLI session"));
    console.log(rule());
    console.log(c.dim(`Host:     ${normalizedHost}`));
    console.log(c.dim(`Machine:  ${hostname()} (${process.platform})`));
    if (targetDocoHandle) console.log(c.dim(`Target:   ${targetDocoHandle} (author)`));
    console.log();

    // 1. Register a public OAuth client, then start the device flow.
    let client: RegisteredClientResponse;
    let init: DeviceAuthorizationResponse;
    try {
      client = await registerCliClient(normalizedHost);
      init = await startDeviceAuthorization(normalizedHost, client.client_id, targetDocoHandle);
    } catch (e) {
      console.error(cross(`Device authorization start failed: ${(e as Error).message}`));
      console.error(c.dim(`Check that ${normalizedHost} is reachable from this machine.`));
      process.exitCode = 1;
      return;
    }

    const authorizeUrl = init.verification_uri_complete;
    const expiresAt = new Date(Date.now() + init.expires_in * 1000).toISOString();

    console.log(checkmark(`Authorization initiated. Short code: ${c.warn(init.user_code)}`));
    console.log(c.dim(`Expires at ${expiresAt}.`));
    console.log();
    if (args["no-open"]) {
      console.log("Open this URL in your browser to authorize:");
      console.log(`  ${c.dim(authorizeUrl)}`);
    } else {
      console.log(`Opening ${c.dim(authorizeUrl)} in your browser…`);
      openInBrowser(authorizeUrl).catch((e) => {
        console.error(
          c.dim(`(Auto-open failed: ${(e as Error).message}. Visit the URL above manually.)`),
        );
      });
    }
    console.log();
    console.log(c.dim(`Waiting for approval (up to ${timeoutSec}s)…`));

    // 2. Poll /oauth/token until the device authorization resolves.
    const deadline = Date.now() + timeoutSec * 1000;
    let pollDelayMs = Math.max(1000, init.interval * 1000);
    while (Date.now() < deadline) {
      await sleep(pollDelayMs);
      try {
        const res = await fetch(`${normalizedHost}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: DEVICE_CODE_GRANT_TYPE,
            device_code: init.device_code,
            client_id: client.client_id,
          }).toString(),
        });
        if (res.ok) {
          const tokens = (await res.json()) as IssuedTokens;
          const bootstrap = await fetchBootstrap(normalizedHost, tokens.access_token);
          const resolvedDoco = await resolveGrantedDoco(
            normalizedHost,
            tokens.access_token,
            targetDocoHandle,
            bootstrap?.oauth_grant?.granted_doco_ids ?? [],
          );

          console.log();
          console.log(
            checkmark(
              `Authorized by ${c.warn(bootstrap?.principal?.username ?? "the approving user")}.`,
            ),
          );
          // DOCO_ACCESS is secret → .env (gitignored). The Doco
          // coordinate lives in .doco/connections.md and should be
          // committed so other agents in other clones discover Doco too.
          //
          const updates: Record<string, string> = {
            DOCO_ACCESS: tokens.access_token,
            DOCO_REFRESH: tokens.refresh_token,
            DOCO_CLIENT_ID: client.client_id,
            DOCO_HOST: normalizedHost,
          };
          writeEnvFile(envPath, env, updates, []);
          console.log(
            checkmark(
              `Wrote DOCO_ACCESS, DOCO_REFRESH, DOCO_CLIENT_ID, and DOCO_HOST to shared repo credential store ${c.dim("./.env")}.`,
            ),
          );

          if (resolvedDoco?.doco_handle) {
            const docoUrl = `${normalizedHost}/${resolvedDoco.doco_handle}/`;
            const target = resolve(process.cwd(), ".doco/connections.md");
            try {
              const { mkdirSync } = await import("node:fs");
              mkdirSync(resolve(process.cwd(), ".doco"), { recursive: true });
            } catch {
              // dir already exists, or fs locked — writeFileSync will
              // surface the real error if any.
            }
            writeFileSync(target, renderConnectionsMd(docoUrl), "utf8");
            console.log(checkmark(`Wrote Doco URL to ${c.dim("./.doco/connections.md")}.`));
          }

          // Install the agent-bootstrap files (AGENTS.md + CLAUDE.md shim +
          // .claude/settings.json + the four hook scripts) into the same
          // repo. The hooks themselves `source .env` on each fire and
          // pick up DOCO_ACCESS — once they're approved (Claude Code:
          // /hooks) the very next UserPromptSubmit picks up the fresh
          // credential (no full session restart needed).
          try {
            const { installAgentBootstrapCmd } = await import("./install-agent-bootstrap.js");
            const originalLog = console.log;
            console.log = () => {};
            try {
              if (!installAgentBootstrapCmd.run) {
                throw new Error("install-agent-bootstrap command has no runner");
              }
              await installAgentBootstrapCmd.run({
                args: {
                  root: process.cwd(),
                  force: true,
                },
              } as never);
            } finally {
              console.log = originalLog;
            }
            console.log(
              checkmark(
                `Installed agent bootstrap (${c.dim("AGENTS.md + CLAUDE.md + .claude/")}).`,
              ),
            );
          } catch (e) {
            console.error(
              c.dim(
                `(install-agent-bootstrap failed: ${(e as Error).message}. Run \`doco install-agent-bootstrap\` manually.)`,
              ),
            );
          }

          if (resolvedDoco?.doco_handle) {
            console.log();
            console.log(c.dim(`Doco URL: ${normalizedHost}/${resolvedDoco.doco_handle}`));
          }
          console.log();
          console.log(c.dim("Next, in this Claude Code session (no restart needed):"));
          console.log(
            c.dim(
              "  1. /hooks — review and approve the new SessionStart + UserPromptSubmit hooks.",
            ),
          );
          console.log(
            c.dim(
              "  2. /clear (optional) — fires SessionStart fresh so the canonical_instructions",
            ),
          );
          console.log(
            c.dim("     get injected. Without /clear, the per-prompt UserPromptSubmit hook still"),
          );
          console.log(c.dim("     re-pushes the protocol checklist on the next user message."));
          console.log(
            c.dim(
              "Other agents: AGENTS.md is now in place; restart per their convention if needed.",
            ),
          );
          console.log();
          console.log(c.dim("Share this Doco connection with the repository:"));
          console.log(
            c.dim(
              "  Agents in this same local checkout share ./.env, so this authorization should stop repeated approval prompts here.",
            ),
          );
          console.log(
            c.dim(
              "  First verify .doco/connections.md, AGENTS.md, and CLAUDE.md exist, even if DOCO_ACCESS already works.",
            ),
          );
          console.log(
            c.dim(
              "  git add .doco/connections.md AGENTS.md CLAUDE.md .agents/doco-agent-client.mjs .claude",
            ),
          );
          console.log(c.dim('  git commit -m "Connect repository to Doco"'));
          console.log(c.dim("  git push"));
          console.log(
            c.dim(
              "Do not commit .env, DOCO_ACCESS, refresh tokens, OAuth client state, or cookies.",
            ),
          );
          return;
        }
        const body = (await safeJson<OauthErrorResponse>(res)) ?? {};
        switch (body.error) {
          case "authorization_pending":
            break;
          case "slow_down":
            pollDelayMs += 5000;
            break;
          case "access_denied":
            console.error(cross("Authorization denied in the browser. No changes made to ./.env."));
            process.exitCode = 1;
            return;
          case "expired_token":
            console.error(cross("Authorization request expired. Run `doco login` again."));
            process.exitCode = 1;
            return;
          default:
            console.error(
              cross(
                `Token exchange failed: ${res.status} ${body.error_description ?? body.error ?? res.statusText}`,
              ),
            );
            process.exitCode = 1;
            return;
        }
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
  return "0.1.1";
}

function renderConnectionsMd(docoUrl: string): string {
  return `# Doco connections

This repo connects to the Doco(s) listed below. A Doco listed here
is one the project owner has linked to this codebase; an agent's
actual read/write access on each one is determined at OAuth time,
not by this file.

## Active connections

- ${docoUrl}

## For Contributors

Need access? Open the Doco URL above and sign in to mint an invite for
yourself. Or ask someone already connected to call:

\`\`\`sh
curl -X POST "${docoUrl.replace(/\/+$/, "")}/api/invites.json" \\
  -H "Authorization: Bearer $DOCO_ACCESS" \\
  -H "Content-Type: application/json" \\
  -d '{"expires_in_days": 7}'
\`\`\`

Agents should store their OAuth credentials in repo-root \`./.env\`
as \`DOCO_ACCESS\`, \`DOCO_REFRESH\`, \`DOCO_CLIENT_ID\`, and
\`DOCO_HOST\`. Agents in the same local checkout share that
credential set. The credentials are secret and gitignored; this file
is the committed, non-secret project coordinate.
`;
}

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

interface RegisteredClientResponse {
  client_id: string;
}

interface DeviceAuthorizationResponse {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface IssuedTokens {
  access_token: string;
  refresh_token: string;
}

interface OauthErrorResponse {
  error?: string;
  error_description?: string;
}

interface BootstrapResponse {
  principal: { id: string; username: string } | null;
  oauth_grant: { granted_doco_ids: string[] } | null;
}

interface DocoLookupResponse {
  doco_id: string;
  doco_handle: string;
}

function readTargetDocoHandle(): string | null {
  const ref = readDocoRefFromProject();
  if (!ref || ref.startsWith("doco_")) return null;
  return ref;
}

async function registerCliClient(normalizedHost: string): Promise<RegisteredClientResponse> {
  const res = await fetch(`${normalizedHost}/oauth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `doco-cli/${cliVersion()} (node ${process.version}; ${process.platform})`,
    },
    body: JSON.stringify({
      client_name: `doco-cli (${hostname()})`,
      redirect_uris: ["urn:ietf:wg:oauth:2.0:oob"],
      software_id: "doco-cli",
      software_version: cliVersion(),
    }),
  });
  if (!res.ok) {
    throw new Error(`client registration failed: ${res.status} ${await renderHttpError(res)}`);
  }
  return (await res.json()) as RegisteredClientResponse;
}

async function startDeviceAuthorization(
  normalizedHost: string,
  clientId: string,
  targetDocoHandle: string | null,
): Promise<DeviceAuthorizationResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    scope: "doco",
  });
  if (targetDocoHandle) {
    body.set("target_doco_handle", targetDocoHandle);
    body.set("requested_role", "author");
  }
  const res = await fetch(`${normalizedHost}/oauth/device_authorization`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": `doco-cli/${cliVersion()} (node ${process.version}; ${process.platform})`,
    },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`device authorization failed: ${res.status} ${await renderHttpError(res)}`);
  }
  return (await res.json()) as DeviceAuthorizationResponse;
}

async function fetchBootstrap(
  normalizedHost: string,
  accessToken: string,
): Promise<BootstrapResponse | null> {
  const res = await fetch(`${normalizedHost}/api/v1/agent-bootstrap.json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as BootstrapResponse;
}

async function resolveGrantedDoco(
  normalizedHost: string,
  accessToken: string,
  targetDocoHandle: string | null,
  grantedDocoIds: string[],
): Promise<DocoLookupResponse | null> {
  if (grantedDocoIds.length === 1) {
    const resolved = await fetchGrantedDoco(normalizedHost, accessToken, grantedDocoIds[0] ?? "");
    if (resolved) return resolved;
  }
  if (!targetDocoHandle) return null;
  return grantedDocoIds[0] ? { doco_id: grantedDocoIds[0], doco_handle: targetDocoHandle } : null;
}

async function fetchGrantedDoco(
  normalizedHost: string,
  accessToken: string,
  docoId: string,
): Promise<DocoLookupResponse | null> {
  if (!docoId) return null;
  const res = await fetch(`${normalizedHost}/api/v1/docos/${encodeURIComponent(docoId)}.json`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as DocoLookupResponse;
}

async function safeText(res: Response): Promise<string | null> {
  try {
    return await res.text();
  } catch {
    return null;
  }
}

async function safeJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

async function renderHttpError(res: Response): Promise<string> {
  const body = await safeJson<OauthErrorResponse>(res);
  if (body?.error_description) return body.error_description;
  if (body?.error) return body.error;
  const text = await safeText(res);
  return text?.slice(0, 200) ?? res.statusText;
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
  const last = filtered[filtered.length - 1];
  if (last !== undefined && last.trim() !== "") {
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
