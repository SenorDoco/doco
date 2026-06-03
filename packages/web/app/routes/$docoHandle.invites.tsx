// /<doco-handle>/invites — web management UI for Doco invites.
//
// Lists all invites (pending / consumed / expired / revoked) and lets
// any user with access to this doco mint a new one with one click.
// The just-minted invite's URL is highlighted at the top with a
// copy-friendly text field.

import type { EntityId } from "@doco/shared";
import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import { PageHeader } from "~/components/page-header";
import { DocoPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { type Invite, InviteStore } from "~/lib/invite-store.server";

type SerializedInvite = {
  code: string;
  url: string;
  status: Invite["status"];
  issued_at: string;
  expires_at: string;
  redeemed_at: string | null;
};

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { handle, me, meta, canonicalOwnerSlug, canonicalDocoSlug } = await loadDocoRouteForRead(
    request,
    params,
  );
  const store = InviteStore.forDoco(rootDir());
  const invites = await store.listInvitesForDoco(meta.docoId as EntityId<"doco">);
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const serialized: SerializedInvite[] = invites.map((i) => ({
    code: i.code,
    url: `${origin}/invite/${i.code}`,
    status: i.status,
    issued_at: i.issued_at,
    expires_at: i.expires_at,
    redeemed_at: i.redeemed_at,
  }));
  return {
    ownerSlug: canonicalOwnerSlug,
    docoSlug: canonicalDocoSlug,
    handle,
    docoId: meta.docoId,
    invites: serialized,
    me,
    canMint: Boolean(me),
  };
}

type ActionResult =
  | { error: string }
  | {
      ok: true;
      invite_url: string;
      doco_url: string;
      recipe_url: string;
      device_url: string;
      expires_at: string;
    };

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}): Promise<ActionResult> {
  const { handle, me, meta } = await loadDocoRouteForRead(request, params);
  if (!me) {
    return { error: "Sign in to mint invites." };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent === "revoke") {
    const code = String(form.get("code") ?? "");
    if (!code) return { error: "Missing invite code." };
    const store = InviteStore.forDoco(rootDir());
    const ok = await store.revokeInvite(code);
    if (!ok) return { error: "Invite not found or no longer pending." };
    return {
      ok: true,
      invite_url: "",
      doco_url: "",
      recipe_url: "",
      device_url: "",
      expires_at: "",
    };
  }
  const ttlRaw = String(form.get("expires_in_days") ?? "7");
  const ttl = Number.parseInt(ttlRaw, 10);
  if (!Number.isFinite(ttl) || ttl < 1 || ttl > 365) {
    return { error: "Pick an expiration between 1 and 365 days." };
  }
  const store = InviteStore.forDoco(rootDir());
  const invite = await store.issueInvite(
    meta.docoId as EntityId<"doco">,
    me.id as EntityId<"principal">,
    ttl,
  );
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  return {
    ok: true,
    invite_url: `${origin}/invite/${invite.code}`,
    doco_url: `${origin}/${handle}/`,
    recipe_url: `${origin}/protocol/agent-oauth-recipe`,
    device_url: `${origin}/device`,
    expires_at: invite.expires_at,
  };
}

export function meta() {
  return [{ title: "Invites · Doco" }];
}

export default function Invites({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: ActionResult;
}) {
  const { ownerSlug, docoSlug, handle, invites, me, canMint } = loaderData;
  const navigation = useNavigation();
  const minting = navigation.state === "submitting";

  return (
    <div>
      <SiteHeader me={me} />
      <DocoPageMain className="py-6 space-y-5">
        <PageHeader
          breadcrumb={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Invites" })}
          title={
            <>
              <Link to={`/${handle}`} className="hover:text-primary">
                {handle}
              </Link>
              <span className="text-muted-foreground"> · invites</span>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            Share an invite URL with a person to grant them access to this doco. Each invite is
            single-use and expires after the chosen window. For agent access, mint an{" "}
            <Link to="/tokens" className="font-semibold text-foreground hover:text-primary">
              API key
            </Link>{" "}
            instead.
          </p>
        </PageHeader>

        <Card>
          <CardHeader>
            <CardTitle>Mint a new invite</CardTitle>
            <CardDescription>
              {canMint
                ? "Single-use; expires in the chosen window. Anyone with the URL can claim access."
                : "Sign in to mint invites."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {canMint ? (
              <Form method="post" className="flex items-end gap-2">
                <label className="text-sm">
                  <span className="block text-xs text-muted-foreground mb-1">
                    Expires in (days)
                  </span>
                  <input
                    type="number"
                    name="expires_in_days"
                    defaultValue={7}
                    min={1}
                    max={365}
                    className="block w-24 rounded-md px-2 py-1 text-sm font-mono"
                  />
                </label>
                <button
                  type="submit"
                  name="intent"
                  value="mint"
                  disabled={minting}
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
                >
                  {minting ? "Minting…" : "Mint invite"}
                </button>
              </Form>
            ) : (
              <Link
                to={`/sign-in?return=${encodeURIComponent(`/${handle}/invites`)}`}
                className="text-primary hover:underline text-sm"
              >
                Sign in
              </Link>
            )}
            {actionData && "error" in actionData ? (
              <p className="mt-3 text-sm text-destructive">{actionData.error}</p>
            ) : null}
            {actionData && "ok" in actionData && actionData.invite_url ? (
              <div className="mt-4 rounded-md border border-primary bg-primary/5 p-3">
                <p className="mb-3 text-sm font-semibold">Fresh invite</p>
                <CollaborationInvitePrompt
                  inviteUrl={actionData.invite_url}
                  note={
                    <>Single-use, expires {new Date(actionData.expires_at).toLocaleString()}.</>
                  }
                />
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>All invites</CardTitle>
            <CardDescription>
              {invites.length === 0 ? "No invites yet." : `${invites.length} total — newest first.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {invites.map((inv) => (
              <InviteRow key={inv.code} invite={inv} canRevoke={canMint} />
            ))}
          </CardContent>
        </Card>
      </DocoPageMain>
    </div>
  );
}

function InviteRow({
  invite,
  canRevoke,
}: {
  invite: SerializedInvite;
  canRevoke: boolean;
}) {
  const statusColor =
    invite.status === "pending"
      ? "text-foreground"
      : invite.status === "consumed"
        ? "text-muted-foreground"
        : "text-muted-foreground";
  return (
    <div className="neu-surface flex items-center justify-between gap-3 rounded-md bg-card px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className={`font-mono break-all ${statusColor}`}>
          {invite.status === "pending" ? invite.url : `${invite.code.slice(0, 12)}…`}
        </div>
        <div className="mt-1 text-muted-foreground">
          {invite.status === "pending" ? (
            <>Pending · expires {new Date(invite.expires_at).toLocaleString()}</>
          ) : invite.status === "consumed" ? (
            <>Consumed {invite.redeemed_at ? new Date(invite.redeemed_at).toLocaleString() : ""}</>
          ) : invite.status === "expired" ? (
            <>Expired {new Date(invite.expires_at).toLocaleString()}</>
          ) : (
            <>Revoked</>
          )}
        </div>
      </div>
      {canRevoke && invite.status === "pending" ? (
        <Form method="post">
          <input type="hidden" name="intent" value="revoke" />
          <input type="hidden" name="code" value={invite.code} />
          <button type="submit" className="neu-button rounded-md px-2 py-1 text-xs">
            Revoke
          </button>
        </Form>
      ) : null}
    </div>
  );
}
