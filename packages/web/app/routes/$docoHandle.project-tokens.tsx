// /<doco-handle>/project-tokens — owner-only management UI for
// committable read-only project tokens.
//
// Mint is gated behind an explicit confirmation checkbox so the
// owner has to acknowledge the trade-off: anyone with read access
// to the repo where the token is committed will be able to read
// this doco. The freshly-minted token body is shown once, with
// install instructions for .doco/project-tokens.json.

import { Form, Link, redirect, useNavigation } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { DocoPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { canAdminDoco, loadDocoRouteForRead } from "~/lib/doco-access.server";
import {
  type ProjectTokenSummary,
  listProjectTokens,
  mintProjectToken,
  revokeProjectTokenById,
} from "~/lib/project-tokens.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}) {
  const { handle, me, meta, canonicalOwnerSlug } = await loadDocoRouteForRead(request, params);
  const isOwner = await canAdminDoco(
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me?.id ?? null,
  );
  if (!isOwner) {
    throw new Response("Forbidden: only the doco's owner can manage project tokens.", {
      status: 403,
    });
  }
  const tokens = await listProjectTokens(meta.docoId);
  return {
    handle,
    ownerSlug: canonicalOwnerSlug,
    docoId: meta.docoId,
    me,
    tokens,
  };
}

type ActionResult =
  | { error: string }
  | { revoked: true }
  | { minted: true; full_token: string; install_hint: string };

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoHandle: string };
}): Promise<ActionResult | Response> {
  const { meta, me, handle } = await loadDocoRouteForRead(request, params);
  if (!me) {
    return { error: "Sign in to manage project tokens." };
  }
  const isOwner = await canAdminDoco({ ownerId: meta.ownerId, docoId: meta.docoId }, me.id);
  if (!isOwner) {
    return { error: "Only the doco's owner can manage project tokens." };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "revoke") {
    const id = String(form.get("id") ?? "");
    if (!id) return { error: "Missing token id." };
    await revokeProjectTokenById({ doco_id: meta.docoId, token_suffix_id: id });
    return redirect(`/${handle}/project-tokens`);
  }

  if (intent === "mint") {
    if (form.get("confirm_repo_readable") !== "on") {
      return {
        error:
          "You must check the confirmation box. Anyone with read access to the repo this token is committed to will be able to read this doco.",
      };
    }
    const label = String(form.get("label") ?? "").trim() || null;
    const result = await mintProjectToken({
      doco_id: meta.docoId,
      created_by_user_id: me.id,
      label,
    });
    const installHint = [
      "Copy this token into the repo at `.doco/project-tokens.json`:",
      "",
      "```json",
      "{",
      `  "${handle}": "${result.full_token}"`,
      "}",
      "```",
      "",
      "Then commit and push the file. Agents that clone the repo will use this token automatically — no OAuth needed for read access.",
    ].join("\n");
    return { minted: true, full_token: result.full_token, install_hint: installHint };
  }

  return { error: "Unknown intent." };
}

export function meta() {
  return [{ title: "Project tokens · Doco" }];
}

export default function ProjectTokensPage({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: ActionResult;
}) {
  const { ownerSlug, handle, tokens, me } = loaderData;
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const justMinted =
    actionData && "minted" in actionData
      ? { full_token: actionData.full_token, install_hint: actionData.install_hint }
      : null;
  const errorMsg = actionData && "error" in actionData ? actionData.error : null;

  return (
    <div>
      <SiteHeader me={me} />
      <DocoPageMain className="py-6 space-y-5">
        <PageHeader
          breadcrumb={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Project tokens" })}
          title={
            <>
              <Link to={`/${handle}`} className="hover:text-primary">
                {handle}
              </Link>
              <span className="text-muted-foreground"> · project tokens</span>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            A project token is a committable, read-only credential for this doco. Commit it to{" "}
            <code>.doco/project-tokens.json</code> in any repo whose readers can also read this doco
            — agents that clone the repo will then read the doco without OAuth.
          </p>
        </PageHeader>

        <Card>
          <CardHeader>
            <CardTitle>Mint a new project token</CardTitle>
            <CardDescription>
              Read-only. Indefinite TTL — revoke from this page when the repo's read access changes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <label className="block text-sm">
                <span className="block text-xs text-muted-foreground mb-1">Label (optional)</span>
                <input
                  type="text"
                  name="label"
                  placeholder="e.g. doco repo bootstrap"
                  className="block w-full max-w-md rounded-md px-2 py-1 text-sm font-mono"
                />
              </label>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name="confirm_repo_readable" className="mt-0.5" required />
                <span>
                  You understand that anyone with read access to a repo where this token is
                  committed will be able to read this doco.
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
                <p className="text-sm font-semibold">Token minted — copy it now</p>
                <p className="text-xs text-muted-foreground">
                  This token body is shown ONCE. If you lose it, revoke and mint a new one.
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
              {tokens.length === 0 ? "None minted yet." : `${tokens.length} total — newest first.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {tokens.map((tok) => (
              <TokenRow key={tok.id} token={tok} />
            ))}
          </CardContent>
        </Card>
      </DocoPageMain>
    </div>
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
