// /<doco-handle>/members — doco-level members management
// (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62). Owner-only. Lists every
// principal with an explicit doco_members row, lets the owner change
// or revoke their role, and mints share-by-revealing invite URLs to
// bring new collaborators in.

import {
  type DocoRole,
  getDocoById,
  getPrincipalById,
  listDocoMembers,
  removeDocoMember,
  ROLE_RANK,
  upsertDocoMember,
} from "@doco/db";
import type { EntityId } from "@doco/shared";
import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { rootDir } from "~/lib/db.server";
import {
  getDocoLevelRole,
  loadDocoForAdmin,
  normalizeDocoParams,
} from "~/lib/doco-access.server";
import { TokenStore } from "~/lib/tokens.server";

const ALL_ROLES: DocoRole[] = ["owner", "approver", "author", "reader"];

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { meta, me } = await loadDocoForAdmin(request, handle);
  const doco = await getDocoById(meta.docoId);
  if (!doco) throw new Response("Doco not found", { status: 404 });

  const members = await listDocoMembers(meta.docoId);
  const enriched = await Promise.all(
    members.map(async (m) => {
      const p = await getPrincipalById(m.principal_id);
      return {
        principal_id: m.principal_id,
        username: p?.username ?? m.principal_id,
        display_name: p?.display_name ?? null,
        role: m.role,
        joined_at: m.joined_at,
      };
    }),
  );

  const inviterRole = me ? await getDocoLevelRole(
    { ownerId: meta.ownerId, docoId: meta.docoId },
    me.id,
  ) : null;

  return {
    ownerSlug,
    docoSlug,
    handle,
    docoId: meta.docoId,
    me,
    members: enriched,
    docoOwnerId: doco.owner_id,
    inviterRole,
  };
}

type ActionResult =
  | { intent: "update"; ok: true; principal_id: string; role: DocoRole }
  | { intent: "remove"; ok: true; principal_id: string }
  | {
      intent: "invite";
      ok: true;
      invite_url: string;
      invite_expires_at: string;
      role: DocoRole;
    }
  | { error: string };

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}): Promise<ActionResult> {
  const { handle } = await normalizeDocoParams(params);
  const { meta, me } = await loadDocoForAdmin(request, handle);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "update") {
    const principalId = String(form.get("principal_id") ?? "").trim();
    const role = String(form.get("role") ?? "") as DocoRole;
    if (!principalId) return { error: "principal_id missing." };
    if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
    await upsertDocoMember({ doco_id: meta.docoId, principal_id: principalId, role });
    return { intent: "update", ok: true, principal_id: principalId, role };
  }

  if (intent === "remove") {
    const principalId = String(form.get("principal_id") ?? "").trim();
    if (!principalId) return { error: "principal_id missing." };
    await removeDocoMember(meta.docoId, principalId);
    return { intent: "remove", ok: true, principal_id: principalId };
  }

  if (intent === "invite") {
    if (!me) return { error: "Sign in to mint invites." };
    const role = String(form.get("role") ?? "author") as DocoRole;
    if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
    const ttlRaw = Number(form.get("expires_in_days") ?? 7);
    const ttlDays = Number.isFinite(ttlRaw) ? Math.min(Math.max(Math.floor(ttlRaw), 1), 365) : 7;

    // Inviter must hold a role ≥ the role they're granting.
    const inviterRole = await getDocoLevelRole(
      { ownerId: meta.ownerId, docoId: meta.docoId },
      me.id,
    );
    if (!inviterRole) {
      return { error: "Only doco members can mint invites." };
    }
    if (ROLE_RANK[role] > ROLE_RANK[inviterRole]) {
      return {
        error: `Cannot mint a '${role}' invite — you only hold '${inviterRole}'. Pick a role at or below your own.`,
      };
    }

    const store = TokenStore.forDoco(rootDir());
    const invite = await store.issueInvite(
      meta.docoId as EntityId<"doco">,
      me.id as EntityId<"principal">,
      ttlDays,
      role,
    );
    const url = new URL(request.url);
    const origin = `${url.protocol}//${url.host}`;
    return {
      intent: "invite",
      ok: true,
      invite_url: `${origin}/invite/${invite.code}`,
      invite_expires_at: invite.expires_at,
      role,
    };
  }

  return { error: `Unknown intent: ${intent}` };
}

export function meta() {
  return [{ title: "Members · Doco" }];
}

export default function DocoMembersPage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={loaderData.me} docoScope={{ handle: loaderData.handle }} />
      <main className="mx-auto w-full max-w-3xl px-6 py-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Members</h1>
            <p className="text-sm text-muted-foreground">
              Manage who has access to{" "}
              <Link to={`/${loaderData.handle}`} className="underline">
                {loaderData.handle}
              </Link>{" "}
              and at what role.
            </p>
          </div>
          <Link
            to={`/${loaderData.handle}/settings`}
            className="text-sm underline text-muted-foreground"
          >
            Back to settings
          </Link>
        </header>

        <InviteCard inviterRole={loaderData.inviterRole} />

        <Card>
          <CardHeader>
            <CardTitle>Doco members</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {loaderData.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No explicit members yet. The doco owner is <code>{loaderData.docoOwnerId}</code>.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-medium">User</th>
                    <th className="pb-2 font-medium">Role</th>
                    <th className="pb-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loaderData.members.map((m) => (
                    <MemberRow key={m.principal_id} member={m} />
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-muted-foreground">
              Effective role on each scope is <code>max(org role, doco role, scope role)</code>. To
              grant a role on a specific scope, open that scope's page and use the Members panel
              there.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function MemberRow({
  member,
}: {
  member: {
    principal_id: string;
    username: string;
    display_name: string | null;
    role: DocoRole;
  };
}) {
  const roleFetcher = useFetcher<ActionResult>();
  const removeFetcher = useFetcher<ActionResult>();
  // Stable identifier for resolving which row's fetcher response is current.
  const justSaved =
    roleFetcher.state === "idle" &&
    roleFetcher.data &&
    "intent" in roleFetcher.data &&
    roleFetcher.data.intent === "update" &&
    roleFetcher.data.principal_id === member.principal_id;
  const error =
    roleFetcher.data && "error" in roleFetcher.data ? roleFetcher.data.error : undefined;

  // Auto-clear the "Saved" indicator after a few seconds so it doesn't
  // linger forever on a quiet page.
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    if (justSaved) {
      setShowSaved(true);
      const t = setTimeout(() => setShowSaved(false), 2000);
      return () => clearTimeout(t);
    }
  }, [justSaved, roleFetcher.data]);

  return (
    <tr data-testid={`member-row-${member.username}`}>
      <td className="py-2 align-middle">
        <div className="font-medium">{member.username}</div>
        {member.display_name ? (
          <div className="text-xs text-muted-foreground">{member.display_name}</div>
        ) : null}
      </td>
      <td className="py-2 align-middle">
        <div className="inline-flex items-center gap-2">
          <select
            defaultValue={member.role}
            data-testid={`role-select-${member.username}`}
            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
            disabled={roleFetcher.state !== "idle"}
            onChange={(e) => {
              roleFetcher.submit(
                {
                  intent: "update",
                  principal_id: member.principal_id,
                  role: e.currentTarget.value,
                },
                { method: "post" },
              );
            }}
          >
            {ALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span
            className="text-xs text-muted-foreground"
            data-testid={`role-status-${member.username}`}
            aria-live="polite"
          >
            {roleFetcher.state !== "idle"
              ? "Saving…"
              : error
                ? <span className="text-destructive">{error}</span>
                : showSaved
                  ? "Saved"
                  : ""}
          </span>
        </div>
      </td>
      <td className="py-2 align-middle text-right">
        <button
          type="button"
          data-testid={`remove-member-${member.username}`}
          disabled={removeFetcher.state !== "idle"}
          onClick={() => {
            if (!confirm(`Remove ${member.username} from this doco?`)) return;
            removeFetcher.submit(
              { intent: "remove", principal_id: member.principal_id },
              { method: "post" },
            );
          }}
          className="rounded-md border border-border px-2 py-1 text-xs text-destructive hover:bg-card disabled:opacity-50"
        >
          {removeFetcher.state !== "idle" ? "Removing…" : "Remove"}
        </button>
      </td>
    </tr>
  );
}

function InviteCard({ inviterRole }: { inviterRole: DocoRole | null }) {
  const fetcher = useFetcher<ActionResult>();
  const result = fetcher.data;
  const inviteResult = result && "intent" in result && result.intent === "invite" ? result : null;
  const error = result && "error" in result ? result.error : undefined;
  const [copied, setCopied] = useState(false);

  const maxRoleRank = inviterRole ? ROLE_RANK[inviterRole] : -1;
  const grantable = ALL_ROLES.filter((r) => ROLE_RANK[r] <= maxRoleRank);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a collaborator</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <fetcher.Form method="post" className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <input type="hidden" name="intent" value="invite" />
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">Role</span>
            <select
              name="role"
              defaultValue={grantable.includes("author") ? "author" : grantable[0]}
              data-testid="invite-role"
              className="rounded-md border border-border bg-background px-3 py-2"
            >
              {grantable.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              Expires (days)
            </span>
            <input
              name="expires_in_days"
              type="number"
              min={1}
              max={365}
              defaultValue={7}
              data-testid="invite-ttl"
              className="rounded-md border border-border bg-background px-3 py-2 w-28"
            />
          </label>
          <button
            type="submit"
            data-testid="invite-submit"
            disabled={fetcher.state !== "idle" || grantable.length === 0}
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {fetcher.state !== "idle" ? "Generating…" : "Generate invite link"}
          </button>
        </fetcher.Form>

        {error ? (
          <p className="text-sm text-destructive" data-testid="invite-error">
            {error}
          </p>
        ) : null}

        {inviteResult ? (
          <div
            className="rounded-md border border-border bg-card p-3 text-sm"
            data-testid="invite-result"
          >
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Share this URL ({inviteResult.role}, expires{" "}
              {new Date(inviteResult.invite_expires_at).toLocaleString()}):
            </div>
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={inviteResult.invite_url}
                data-testid="invite-url"
                className="flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs"
                onFocus={(e) => e.currentTarget.select()}
              />
              <button
                type="button"
                data-testid="invite-copy"
                onClick={() => {
                  navigator.clipboard.writeText(inviteResult.invite_url).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="rounded-md border border-border px-2 py-1 text-xs hover:bg-input"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Single-use invite. The redeemer's role is fixed when this link is minted; changing the
              role below won't affect already-sent links.
            </p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
