// /workspaces/<workspace-handle>/hook-tokens: a member's read-only hook
// tokens for the workspace, each reading it as them
// (lib/hook-tokens.server). An owner sees and revokes everyone's. A minted
// token is shown once, with the message that has an agent save it in
// .doco/hook-tokens.json, kept out of git, and turn on the Doco hook.

import { getPublicBaseUrl } from "@doco/shared";
import { Form, Link, redirect, useNavigation } from "react-router";
import { AgentInstructionsBlock } from "~/components/agent-instructions-block";
import { Breadcrumb, workspaceBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageMain } from "~/components/page-main";
import {
  type HookTokenSummary,
  hookTokenInstallHint,
  listHookTokens,
  mintHookToken,
  revokeHookTokenById,
} from "~/lib/hook-tokens.server";
import { loadWorkspaceForHookTokens } from "~/lib/workspace-helpers.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const member = await loadWorkspaceForHookTokens(request, params.workspaceHandle);
  if (!member.ok) {
    if (member.status === 401) {
      throw redirect(`/sign-in?next=${encodeURIComponent(new URL(request.url).pathname)}`);
    }
    throw new Response(member.error, { status: member.status });
  }
  return {
    workspaceHandle: member.workspace.handle,
    everyones: member.madeBy === null,
    tokens: await listHookTokens(member.workspace.id, member.madeBy),
  };
}

type ActionResult = { error: string } | { minted: true; full_token: string; install_hint: string };

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}): Promise<ActionResult | Response> {
  const member = await loadWorkspaceForHookTokens(request, params.workspaceHandle);
  if (!member.ok) return { error: member.error };
  const { workspace, me, madeBy } = member;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "revoke") {
    const id = String(form.get("id") ?? "");
    if (!id) return { error: "Missing token id." };
    await revokeHookTokenById({
      workspace_id: workspace.id,
      token_suffix_id: id,
      created_by_user_id: madeBy,
    });
    return redirect(`/workspaces/${workspace.handle}/hook-tokens`);
  }

  if (intent === "mint") {
    const result = await mintHookToken({
      workspace_id: workspace.id,
      created_by_user_id: me.id,
      label: String(form.get("label") ?? "").trim() || null,
    });
    return {
      minted: true,
      full_token: result.full_token,
      install_hint: hookTokenInstallHint(
        getPublicBaseUrl(request),
        workspace.handle,
        result.full_token,
      ),
    };
  }

  return { error: "Unknown intent." };
}

export function meta({ params }: { params: { workspaceHandle: string } }) {
  return [{ title: `Hook tokens · ${params.workspaceHandle} · Doco` }];
}

export default function HookTokensPage({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: ActionResult;
}) {
  const { workspaceHandle, everyones, tokens } = loaderData;
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const justMinted = actionData && "minted" in actionData ? actionData : null;
  const errorMsg = actionData && "error" in actionData ? actionData.error : null;

  return (
    <PageMain className="py-6 space-y-4">
      <Breadcrumb
        items={workspaceBreadcrumb({ workspaceSlug: workspaceHandle, pageLabel: "Hook tokens" })}
      />
      <p className="text-sm text-muted-foreground">
        A hook token reads, and only reads, what you can read in {workspaceHandle}, as you. The Doco
        hook briefs your agent with one: your agent gets it from Doco&apos;s{" "}
        <code>doco_hook_token</code> tool and keeps it in <code>.doco/hook-tokens.json</code>, out
        of git. Mint one here for anything else that should read the workspace as you.
        {everyones ? " As an owner, you see and revoke everyone's." : null}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Mint a hook token</CardTitle>
          <CardDescription>
            Read-only, with no expiry. It stops reading what you can no longer read; revoke it here
            any time.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-3">
            <label className="block text-sm">
              <span className="block text-xs text-muted-foreground mb-1">Label (optional)</span>
              <input
                type="text"
                name="label"
                placeholder="e.g. my laptop"
                className="block w-full max-w-md rounded-md px-2 py-1 text-sm font-mono"
              />
            </label>
            <button
              type="submit"
              name="intent"
              value="mint"
              disabled={submitting}
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {submitting ? "Minting…" : "Mint hook token"}
            </button>
          </Form>
          {errorMsg ? <p className="mt-3 text-sm text-destructive">{errorMsg}</p> : null}
          {justMinted ? (
            <div className="mt-4 rounded-md border border-primary bg-primary/5 p-3 space-y-2">
              <p className="text-sm font-semibold">Token minted. Copy it now.</p>
              <p className="text-xs text-muted-foreground">
                The token is shown once. If you lose it, revoke it and mint another.
              </p>
              <pre className="overflow-x-auto rounded bg-background px-2 py-1 text-xs font-mono">
                {justMinted.full_token}
              </pre>
              <AgentInstructionsBlock
                title="Message for your agent"
                instructions={justMinted.install_hint}
              />
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{everyones ? "Everyone's hook tokens" : "Your hook tokens"}</CardTitle>
          <CardDescription>
            {tokens.length === 0 ? "None minted yet." : `${tokens.length} in all, newest first.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {tokens.map((token) => (
            <TokenRow key={token.id} token={token} showMaker={everyones} />
          ))}
        </CardContent>
      </Card>
      {everyones ? (
        <p className="text-xs text-muted-foreground">
          <Link to={`/workspaces/${workspaceHandle}/settings`} className="hover:underline">
            Back to settings
          </Link>
        </p>
      ) : null}
    </PageMain>
  );
}

function TokenRow({ token, showMaker }: { token: HookTokenSummary; showMaker: boolean }) {
  return (
    <div className="neu-surface flex items-center justify-between gap-3 rounded-md bg-card px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="font-mono break-all">{token.preview}</div>
        <div className="mt-1 text-muted-foreground">
          {token.label ? <>{token.label} · </> : null}
          {showMaker && token.created_by ? <>@{token.created_by} · </> : null}
          {token.revoked ? "Revoked" : "Active"} · minted{" "}
          {new Date(token.created_at).toLocaleString()}
          {token.last_used_at
            ? ` · last used ${new Date(token.last_used_at).toLocaleString()}`
            : " · never used"}
        </div>
      </div>
      {!token.revoked ? (
        <Form method="post">
          <input type="hidden" name="intent" value="revoke" />
          <input type="hidden" name="id" value={token.id} />
          <button type="submit" className="neu-button rounded-md px-2 py-1 text-xs">
            Revoke
          </button>
        </Form>
      ) : null}
    </div>
  );
}
