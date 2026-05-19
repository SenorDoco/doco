// Onboarding step: hand the Doco off to an AI agent.
//
// Reached from the scope-setup flow's "Continue to Doco →" link after
// the project owner has decided which scopes to use. The page mints a
// fresh 7-day invite for the signed-in admin and renders a copy-paste
// prompt the project owner can hand to their agent in another tool
// (Claude Code, Cursor, Codex, …). The Continue button closes the
// onboarding loop and routes onward to /:handle.
//
// The "Keep it simple" path on /new-doco does NOT route through here —
// that path opts out of the agent handoff by design.

import { useState } from "react";
import { Link } from "react-router";
import type { EntityId } from "@doco/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";
import { TokenStore } from "~/lib/tokens.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { handle } = await normalizeDocoParams(params);
  const { meta, me } = await loadDocoForAdmin(request, handle);

  const store = TokenStore.forDoco(rootDir());
  const invite = await store.issueInvite(
    meta.docoId as EntityId<"doco">,
    (me?.id ?? null) as EntityId<"principal"> | null,
    7,
  );
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const inviteUrl = `${origin}/invite/${invite.code}`;

  return { handle, inviteUrl, me };
}

export function meta() {
  return [{ title: "Hand it to your AI agent · Doco" }];
}

export default function OnboardingAgent({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { handle, inviteUrl, me } = loaderData;
  const agentPrompt = [
    "I want to start using Doco on this project. Please redeem this invite URL:",
    "",
    inviteUrl,
    "",
    "Then bootstrap EVERY scope on the Doco. Start by rendering a checklist of all scopes from the bootstrap response — one bullet per scope showing its `summary` (what it's for) and `accepts:` filter (which node types it accepts). Pre-check any scope that already carries captured nodes. Re-render the checklist as you finish each scope so I can see progress. Example shape:",
    "",
    "    Bootstrapping scopes:",
    "    - [ ] 🌐 #global — Your doco's rule book (accepts: rule)",
    "    - [ ] ⭐ #important — Important doco-wide decisions (accepts: anything)",
    "    - [ ] 🌊 #user-flows — End-to-end user journeys (accepts: anything)",
    "",
    "ROUTING — file each finding by the scope's `accepts`, not by guessing names:",
    "    - Findings that are RULES (authoring or guidance) go on the scope whose `accepts` includes `rule` (typically `#global`, which is rules-only).",
    "    - Findings that are DECISIONS / intents / cross-cutting non-rule content go on the scope whose `accepts` is unrestricted (typically `#important` on a default Doco — the catch-all for cross-cutting decisions).",
    "    - Findings with a clear topical home land on the MOST SPECIFIC matching scope (architectural decisions on `#adrs`, deploy policy on `#deployments`, journey content on `#user-flows`, etc.). Use the scope's `summary` as the topic filter.",
    "    - NEVER try to POST a Decision onto `#global` — the capture gate will reject it with `allowed_node_types failed`. Re-file on `#important` without bothering me about the mis-route.",
    "",
    "For each unchecked scope, walk this loop: (1) READ what's relevant to that scope from the repo AND your auto-memory of corrections I've given you, using the scope's `summary` as the topic filter. Sources: README, CLAUDE.md / AGENTS.md, your per-project agent memory, package.json + deploy config (vercel.json, fly.toml, Dockerfile, etc.), top-level structure, and `git log --oneline -30`. (2) EXTRACT every explicit decision, rule, and guidance I've stated that fits this scope — not a sample, not the top 2-3, ALL of them. Keep only the buckets the scope's `accepts` allows:",
    "    - Decision: a one-time choice with alternatives (stack, deploy target, workflow choice, etc.) — only when scope accepts decision",
    '    - Rule (authoring): an ongoing constraint with a predicate (e.g. "every ADR must include alternatives_considered", "don\'t commit unprompted") — only when scope accepts rule',
    '    - Rule (guidance): an ongoing reminder without enforcement (e.g. "verify on the deployed site, not locally", "document corrections same-turn") — only when scope accepts rule',
    "(3) PROPOSE the batch for THAT scope only, listing only the buckets it accepts. (4) Wait for my confirmation, then capture in a single batch. (5) Flip the scope to [x] in the checklist (with the count) and re-render the full checklist. (6) Move to the next unchecked scope.",
    "",
    "If a finding doesn't fit any current scope, propose adding a new scope FIRST and wait for my OK. Don't print 'Onboarding done' until every scope on the checklist is checked off or I've explicitly deferred remaining ones.",
  ].join("\n");
  const [copied, setCopied] = useState(false);
  const [copiedRuntime, setCopiedRuntime] = useState<string | null>(null);
  // MCP connector install commands. The server URL is the host's /mcp
  // route (Streamable HTTP transport). One install per runtime, takes
  // effect on the next session — so the agent-handoff prompt below is
  // still the way to bootstrap THIS session.
  const mcpUrl = "https://doco.to/mcp";
  const runtimes: { id: string; label: string; command: string; note?: string }[] = [
    {
      id: "claude-code",
      label: "Claude Code",
      command: `claude mcp add doco ${mcpUrl}`,
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      command: `{\n  "mcpServers": {\n    "doco": { "url": "${mcpUrl}" }\n  }\n}`,
      note: "Paste this into ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) / %APPDATA%/Claude/claude_desktop_config.json (Windows), then restart Claude Desktop.",
    },
    {
      id: "cursor",
      label: "Cursor",
      command: mcpUrl,
      note: "Cursor → Settings → MCP → Add server. Paste the URL above, then restart Cursor.",
    },
  ];
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>1. Install the Doco connector (preferred)</CardTitle>
            <CardDescription>
              Once installed, your AI agent gets native Doco tools — search, list scopes, capture
              decisions — without raw curl. One install per agent runtime; future Doco-tracked
              projects you bootstrap reuse it. <strong>Installs take effect on your next session</strong>,
              so this session still goes through the copy-paste prompt below.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {runtimes.map((rt) => (
              <div key={rt.id} className="rounded-md border border-border p-3 space-y-2">
                <p className="text-sm font-semibold">{rt.label}</p>
                <pre className="rounded-md border border-border bg-input p-2 text-[11px] whitespace-pre-wrap break-words">
                  {rt.command}
                </pre>
                {rt.note ? (
                  <p className="text-[11px] text-muted-foreground">{rt.note}</p>
                ) : null}
                <button
                  type="button"
                  onClick={async () => {
                    await navigator.clipboard.writeText(rt.command);
                    setCopiedRuntime(rt.id);
                    setTimeout(() => setCopiedRuntime(null), 1500);
                  }}
                  className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-input"
                >
                  {copiedRuntime === rt.id ? "Copied!" : "Copy"}
                </button>
              </div>
            ))}
            <p className="text-[11px] text-muted-foreground">
              Server URL (Streamable HTTP transport): <code className="rounded bg-input px-1 py-0.5">{mcpUrl}</code> · Auth: <code className="rounded bg-input px-1 py-0.5">Authorization: Bearer ${"{"}DOCO_ACCESS{"}"}</code>
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Or: hand it to your AI agent for this session</CardTitle>
            <CardDescription>
              If you'd rather not install the connector yet, paste this prompt into your agent's
              chat. It'll redeem the invite, read your repo, and propose load-bearing decisions,
              rules, and guidance worth capturing. Works regardless of whether you install the
              connector above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <pre className="rounded-md border border-border bg-input p-3 text-[11px] whitespace-pre-wrap break-words">
              {agentPrompt}
            </pre>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(agentPrompt);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-input"
              >
                {copied ? "Copied!" : "Copy prompt"}
              </button>
              <Link
                to={`/${handle}`}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                Continue to Doco →
              </Link>
            </div>
            <p className="text-[11px] text-muted-foreground">
              Single-use invite, expires in 7 days. Each agent gets its own credential.
            </p>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
