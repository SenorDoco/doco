import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import type { EntityId } from "@doco/shared";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import { listOrgsOwnedOrAdminedBy, loadHostConfig } from "~/lib/host";
import { createDocoInHost, reindex } from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session";
import { TokenStore } from "~/lib/tokens.server";

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");
  const orgs = await listOrgsOwnedOrAdminedBy(me.id);
  return { me, orgs, host: await loadHostConfig() };
}

export async function action({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");
  const form = await request.formData();
  const ownerSlug = String(form.get("owner") ?? "").trim();
  const docoSlug = String(form.get("doco_handle") ?? "")
    .trim()
    .toLowerCase();
  const description = String(form.get("description") ?? "").trim();
  const visibility = String(form.get("visibility") ?? "private") as "private" | "public";

  if (!ownerSlug || !docoSlug) return { error: "Owner and Doco handle are required." };
  if (ownerSlug !== me.username) {
    const allowed = (await listOrgsOwnedOrAdminedBy(me.id)).find((o) => o.slug === ownerSlug);
    if (!allowed) return { error: `You can't create docos under "${ownerSlug}".` };
  }
  try {
    const rec = await createDocoInHost(rootDir(), {
      ownerSlug,
      docoSlug,
      ...(description ? { description } : {}),
      visibility,
    });
    // Build an empty per-Doco index so the web's loaders can read it.
    await reindex(rec.path, rec.docoId);
    // Mint a 7-day invite the project owner can hand to their AI
    // agent. The agent already has repo access in another tool (Claude
    // Code, Cursor, Codex, …) but no Doco access — the invite is what
    // bridges the two. The success-card UI embeds the invite_url into
    // a copy-paste prompt so the project owner can hand it off
    // without learning the wire shape themselves.
    const store = TokenStore.forDoco(rootDir());
    const invite = await store.issueInvite(
      rec.docoId as EntityId<"doco">,
      me.id as EntityId<"principal">,
      7,
    );
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    const inviteUrl = `${origin}/invite/${invite.code}`;
    // Render the success step inline so the user gets explicit "Doco
    // created" confirmation before being pushed to scope setup (ADR-080
    // rev 2 — scopes are the explicit second step but skippable).
    return { ok: { ownerSlug, docoSlug, handle: rec.handle, inviteUrl } };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

export function meta() {
  return [{ title: "New doco · Doco" }];
}

export default function NewDoco({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?:
    | {
        error?: string;
        ok?: { ownerSlug: string; docoSlug: string; handle: string; inviteUrl: string };
      }
    | undefined;
}) {
  const { me, orgs, host } = loaderData;
  const owners = [
    { slug: me.username, label: `${me.username} (you)`, kind: "principal" as const },
    ...orgs.map((o) => ({ slug: o.slug, label: `${o.slug} (org)`, kind: "organization" as const })),
  ];

  if (actionData?.ok) {
    const { handle, inviteUrl } = actionData.ok;
    return <NewDocoCreatedView handle={handle} inviteUrl={inviteUrl} me={me} />;
  }

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-2xl px-6 py-8">
        <Card>
          <CardHeader>
            <CardTitle>New doco</CardTitle>
            <CardDescription>
              Create a new doco owned by you or one of your organizations.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Owner</span>
                <select
                  name="owner"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  {owners.map((o) => (
                    <option key={o.slug} value={o.slug}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Handle</span>
                <input
                  type="text"
                  name="doco_handle"
                  required
                  pattern="[a-z0-9_-]+"
                  placeholder="my-doco"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Lowercase kebab-case. URL becomes /&lt;handle&gt;.
                </span>
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Description (optional)</span>
                <textarea
                  name="description"
                  rows={3}
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </label>
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Visibility</span>
                <select
                  name="visibility"
                  defaultValue="private"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </label>
              <p className="text-[11px] text-muted-foreground">
                Next step after creation: set up the scopes you want to document in. You can also
                add scopes later.
              </p>
              {actionData?.error ? (
                <p className="text-xs text-destructive">{actionData.error}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Create doco
                </button>
                <Link
                  to="/dashboard"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </Link>
              </div>
            </Form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

// Doco-created success view. Lives in its own component so the copy-
// button useState hook doesn't sit inside a conditional in the parent.
// The two-path question wording is intentionally identical to the
// agent-side onboarding_overlay.scope_setup (see
// lib/bootstrap-context.server.ts) — humans and agents see the same
// fork in the same words. Keep both in sync if either rewords. The
// agent-prompt block below the paths embeds an already-minted invite
// URL so the project owner can hand a working credential to their AI
// agent in another tool (Claude Code, Cursor, Codex, …) without
// learning the wire shape themselves.
function NewDocoCreatedView({
  handle,
  inviteUrl,
  me,
}: {
  handle: string;
  inviteUrl: string;
  me: Awaited<ReturnType<typeof loader>>["me"];
}) {
  const agentPrompt = [
    "I want to start using Doco on this project. Please redeem this invite URL:",
    "",
    inviteUrl,
    "",
    "Then read the repo and propose 2-3 load-bearing decisions worth capturing on each scope (or just on #global if no extra scopes are set up). Skim README, CLAUDE.md / AGENTS.md, package.json, deploy config (vercel.json, fly.toml, Dockerfile, etc.), and recent `git log --oneline`. For each candidate, tell me one line of what you found and which scope it would land on. Wait for my confirmation before capturing.",
  ].join("\n");
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-2xl px-6 py-8 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Doco created · {handle}</CardTitle>
            <CardDescription>
              Two ways to use Doco — pick one (you can change later).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="rounded-md border border-border p-3 space-y-2">
              <p className="text-sm font-semibold">Keep it simple</p>
              <p className="text-xs text-muted-foreground">
                Do you want to keep it simple and use Doco to store important decisions so people,
                agents, and work stay aligned? Decisions land on the framework-seeded{" "}
                <code className="rounded bg-input px-1 py-0.5 text-[11px]">#global</code> scope —
                no extra setup. Capture decisions whenever you have something to record, either
                here in the web or by asking an AI agent on the project.
              </p>
              <Link
                to={`/${handle}`}
                className="inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                Continue to Doco →
              </Link>
            </div>
            <div className="rounded-md border border-border p-3 space-y-2">
              <p className="text-sm font-semibold">Document something specific</p>
              <p className="text-xs text-muted-foreground">
                Or do you want to document something specific (for example, user flows, ADRs,
                state machines, design language, etc.)? We'll set up dedicated scopes — topical
                buckets — for each area you want to track, and the captured nodes file under the
                right one.
              </p>
              <Link
                to={`/${handle}/scopes/new?onboarding=1`}
                className="inline-block rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                Set up scopes →
              </Link>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Hand it to your AI agent</CardTitle>
            <CardDescription>
              Your AI agent — Claude Code, Cursor, Codex, etc. — already has access to your repo.
              Paste this prompt into your agent's chat and it'll redeem the invite, read the code,
              and propose load-bearing decisions worth capturing. Works for either path above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <pre className="rounded-md border border-border bg-input p-3 text-[11px] whitespace-pre-wrap break-words">
{agentPrompt}
            </pre>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(agentPrompt);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                {copied ? "Copied!" : "Copy prompt"}
              </button>
              <p className="text-[11px] text-muted-foreground">
                Single-use invite, expires in 7 days. Each agent gets its own credential.
              </p>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
