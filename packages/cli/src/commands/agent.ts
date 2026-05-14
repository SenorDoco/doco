import { defineCommand } from "citty";
import { c, checkmark, cross, header, rule } from "../output.js";

const registerCmd = defineCommand({
  meta: {
    name: "register",
    description:
      "Redeem an invitation token. Self-introduce + receive a long-lived session token (ADR-037, ADR-068).",
  },
  args: {
    server: {
      type: "string",
      description: "Server URL (default http://127.0.0.1:8787).",
      default: "http://127.0.0.1:8787",
    },
    "invite-token": {
      type: "string",
      description: "The invitation token (from the URL the user shared with you).",
      required: true,
    },
    "display-name": {
      type: "string",
      description: "Human-readable agent name.",
      required: true,
    },
    model: { type: "string", description: "Model identifier (e.g., claude-opus-4-7)." },
    provider: { type: "string", description: "Model provider (anthropic, openai, ...)." },
    capabilities: {
      type: "string",
      description: "Comma-separated capabilities: read,write,execute",
      default: "read,write",
    },
  },
  async run({ args }) {
    const inviteToken = args["invite-token"] as string;
    const url = `${args.server}/api/v1/invitations/redeem`;
    const capabilities = (args.capabilities as string).split(",").map((s) => s.trim()).filter(Boolean);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${inviteToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        display_name: args["display-name"],
        ...(args.model ? { model: args.model } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
        capabilities,
      }),
    });
    if (!res.ok) {
      console.error(cross(`HTTP ${res.status}: ${await res.text()}`));
      process.exitCode = 1;
      return;
    }
    const body = (await res.json()) as {
      session_token: string;
      principal: { id: string; username: string };
    };
    console.log();
    console.log(header(`Registered as ${body.principal.username}`));
    console.log(rule());
    console.log(checkmark(`Principal ID:    ${c.dim(body.principal.id)}`));
    console.log(checkmark(`Session token:   ${c.bold(body.session_token)}`));
    console.log();
    console.log(c.dim("Store in your environment so future requests + child agents can use it:"));
    console.log();
    console.log(`  export DOCO_TOKEN=${body.session_token}`);
    console.log();
    console.log(c.dim("Spawn a child agent later via:"));
    console.log(
      c.dim(`  curl -X POST -H "Authorization: Bearer $DOCO_TOKEN" \\
       ${args.server}/api/v1/agents/spawn -d '{"display_name":"..."}'`),
    );
    console.log();
  },
});

export const agentCmd = defineCommand({
  meta: { name: "agent", description: "Agent identity flows (ADR-035, ADR-037, ADR-068)." },
  subCommands: { register: registerCmd },
});
