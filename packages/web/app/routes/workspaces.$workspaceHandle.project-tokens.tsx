// /workspaces/<workspace-handle>/project-tokens: owner-only management of the
// workspace's committable read-only project tokens (lib/project-tokens.server).
//
// Minting sits behind a confirmation checkbox: anyone with read access to the
// repository the token is committed to will read every doco in this
// workspace. The minted token is shown once, with what to paste into
// .doco/project-tokens.json.

import { Form, Link, redirect, useNavigation } from "react-router";
import { Breadcrumb, workspaceBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageMain } from "~/components/page-main";
import {
  type ProjectTokenSummary,
  listProjectTokens,
  mintProjectToken,
  projectTokenInstallHint,
  revokeProjectTokenById,
} from "~/lib/project-tokens.server";
import { loadWorkspaceForOwner } from "~/lib/workspace-helpers.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { workspaceHandle: string };
}) {
  const owner = await loadWorkspaceForOwner(request, params.workspaceHandle);
  if (!owner.ok) {
    if (owner.status === 401) {
      throw redirect(`/sign-in?next=${encodeURIComponent(new URL(request.url).pathname)}`);
    }
    throw new Response(owner.error, { status: owner.status });
  }
  return {
    workspaceHandle: owner.workspace.handle,
    tokens: await listProjectTokens(owner.workspace.id),
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
  const owner = await loadWorkspaceForOwner(request, params.workspaceHandle);
  if (!owner.ok) return { error: owner.error };
  const { workspace, me } = owner;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "revoke") {
    const id = String(form.get("id") ?? "");
    if (!id) return { error: "Missing token id." };
    await revokeProjectTokenById({ workspace_id: workspace.id, token_suffix_id: id });
    return redirect(`/workspaces/${workspace.handle}/project-tokens`);
  }

  if (intent === "mint") {
    if (form.get("confirm_repo_readable") !== "on") {
      return {
        error:
          "Check the confirmation box first: anyone with read access to the repository this token is committed to will read every doco in this workspace.",
      };
    }
    const result = await mintProjectToken({
      workspace_id: workspace.id,
      created_by_user_id: me.id,
      label: String(form.get("label") ?? "").trim() || null,
    });
    return {
      minted: true,
      full_token: result.full_token,
      install_hint: projectTokenInstallHint(workspace.handle, result.full_token),
    };
  }

  return { error: "Unknown intent." };
}

export function meta({ params }: { params: { workspaceHandle: string } }) {
  return [{ title: `Project tokens · ${params.workspaceHandle} · Doco` }];
}

export default function ProjectTokensPage({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: ActionResult;
}) {
  const { workspaceHandle, tokens } = loaderData;
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const justMinted = actionData && "minted" in actionData ? actionData : null;
  const errorMsg = actionData && "error" in actionData ? actionData.error : null;

  return (
    <PageMain className="py-6 space-y-4">
      <Breadcrumb
        items={workspaceBreadcrumb({ workspaceSlug: workspaceHandle, pageLabel: "Project tokens" })}
      />
      <p className="text-sm text-muted-foreground">
        A project token is a committable, read-only credential for every doco in this workspace.
        Commit it to <code>.doco/project-tokens.json</code> in a repository whose readers may also
        read the workspace: the Doco hook and the agents that clone the repository then read it
        without OAuth. Only workspace owners can mint and revoke tokens.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Mint a project token</CardTitle>
          <CardDescription>
            Read-only, with no expiry. Revoke it here when the repository's read access changes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-3">
            <label className="block text-sm">
              <span className="block text-xs text-muted-foreground mb-1">Label (optional)</span>
              <input
                type="text"
                name="label"
                placeholder="e.g. the product repository"
                className="block w-full max-w-md rounded-md px-2 py-1 text-sm font-mono"
              />
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" name="confirm_repo_readable" className="mt-0.5" required />
              <span>
                Anyone with read access to a repository where this token is committed will be able
                to read every doco in this workspace.
              </span>
            </label>
            <button
              type="submit"
              name="intent"
              value="mint"
              disabled={submitting}
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
            >
              {submitting ? "Minting…" : "Mint project token"}
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
              <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-background px-2 py-1 text-xs">
                {justMinted.install_hint}
              </pre>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All project tokens</CardTitle>
          <CardDescription>
            {tokens.length === 0 ? "None minted yet." : `${tokens.length} in all, newest first.`}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {tokens.map((token) => (
            <TokenRow key={token.id} token={token} />
          ))}
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        <Link to={`/workspaces/${workspaceHandle}/settings`} className="hover:underline">
          Back to settings
        </Link>
      </p>
    </PageMain>
  );
}

function TokenRow({ token }: { token: ProjectTokenSummary }) {
  return (
    <div className="neu-surface flex items-center justify-between gap-3 rounded-md bg-card px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="font-mono break-all">{token.preview}</div>
        <div className="mt-1 text-muted-foreground">
          {token.label ? <>{token.label} · </> : null}
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
