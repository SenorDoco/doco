import { defineCommand } from "citty";
import { c, checkmark, cross, header, rule } from "../output.js";

const createCmd = defineCommand({
  meta: {
    name: "create",
    description: "Issue a 5-minute single-use invitation token (ADR-037).",
  },
  args: {
    server: {
      type: "string",
      description: "Server URL (default http://127.0.0.1:8787).",
      default: "http://127.0.0.1:8787",
    },
    token: { type: "string", description: "Bearer session token (omit if server runs in local --as-principal mode)." },
  },
  async run({ args }) {
    const url = `${args.server}/api/v1/invitations`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (args.token) headers.authorization = `Bearer ${args.token}`;
    const res = await fetch(url, { method: "POST", headers });
    if (!res.ok) {
      console.error(cross(`HTTP ${res.status}: ${await res.text()}`));
      process.exitCode = 1;
      return;
    }
    const body = (await res.json()) as {
      token: string;
      url: string;
      expires_at: string;
      inviter: { username: string };
    };
    console.log();
    console.log(header(`Invitation issued by ${body.inviter.username}`));
    console.log(rule());
    console.log(checkmark(`URL:        ${c.bold(body.url)}`));
    console.log(checkmark(`Token:      ${c.dim(body.token)}`));
    console.log(checkmark(`Expires:    ${body.expires_at}`));
    console.log();
    console.log(c.dim("Share the URL with the agent. They have 5 minutes to redeem (single-use)."));
    console.log();
  },
});

export const inviteCmd = defineCommand({
  meta: { name: "invite", description: "Manage invitation tokens (ADR-068)." },
  subCommands: { create: createCmd },
});
