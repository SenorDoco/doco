// GET + POST /device — human-facing landing page for the Device
// Authorization Grant (RFC 8628).
//
// The flow the user walks through:
//   1. Their client shows them a short code (e.g. "WXYZ-1234") and tells
//      them to open https://doco.to/device.
//   2. They land here, prefilled if the client passed
//      verification_uri_complete (?user_code=...), otherwise they type
//      the code into the form.
//   3. If they're not signed in, we redirect through GitHub OAuth and
//      come back with the user_code preserved as a query param.
//   4. The post-sign-in screen shows the token name + a list of
//      Docos they own/admin/are granted access to; they pick which to
//      grant, click Approve, and we mark the device-authorization row
//      approved. The client's next poll at /oauth/token mints + receives
//      the access token.
//   5. Cancel marks the row denied; the client's next poll gets
//      access_denied and stops.

import type { DocoRole } from "@doco/db";
import { getOrgRole } from "@doco/db";
import { Form, redirect, useLoaderData } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { OAuthAccessApprovalForm } from "~/components/oauth-access-approval-form";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { getDocoById } from "~/lib/db.server";
import { getDocoLevelRole, listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";
import { listOrgsOwnedOrAdminedBy } from "~/lib/host.server";
import { readOAuthApprovalGrants } from "~/lib/oauth-approval-grants.server";
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  getClient,
  getDeviceAuthorizationByUserCode,
} from "~/lib/oauth-server.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface LoaderData {
  user_code: string;
  stage: "enter-code" | "approve" | "done" | "expired" | "denied" | "unknown";
  client_name?: string;
  docos?: {
    id: string;
    handle: string;
    my_role: DocoRole;
    // The org that owns this Doco (owner_id === organization_…), or
    // null when the user owns it directly. Drives the picker grouping.
    org_id: string | null;
    // The owning org's handle, so the picker can label that org's
    // bucket even when the user isn't a member of it.
    org_label: string | null;
  }[];
  orgs?: {
    id: string;
    handle: string;
    display_name: string;
    my_role: DocoRole;
  }[];
  target_doco_handle?: string | null;
  requested_role?: DocoRole | null;
  targeted_message?: string | null;
  message?: string;
  me: Awaited<ReturnType<typeof getCurrentPrincipal>>;
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const user_code = (url.searchParams.get("user_code") ?? "").trim().toUpperCase();
  const me = await getCurrentPrincipal(request);

  if (!user_code) {
    return { user_code: "", stage: "enter-code" as const, me };
  }

  const row = await getDeviceAuthorizationByUserCode(user_code);
  if (!row) {
    return {
      user_code,
      stage: "unknown" as const,
      message: "We don't recognize this code. Double-check what your client showed you.",
      me,
    };
  }
  if (row.expires_at.getTime() <= Date.now()) {
    return {
      user_code,
      stage: "expired" as const,
      message: "This code has expired. Ask your client to start a new device authorization.",
      me,
    };
  }
  if (row.status === "denied") {
    return {
      user_code,
      stage: "denied" as const,
      message: "This authorization was already denied.",
      me,
    };
  }
  if (row.status === "approved") {
    return {
      user_code,
      stage: "done" as const,
      message: "Approved.",
      me,
    };
  }

  // status === 'pending'. Require sign-in before showing the approve UI.
  if (!me) {
    const returnPath = `/device?user_code=${encodeURIComponent(user_code)}`;
    throw redirect(`/auth/github?return=${encodeURIComponent(returnPath)}`);
  }

  const client = await getClient(row.client_id);
  // Only owners can grant token access (writers/readers
  // can't extend access). Filter the candidate Doco list to
  // owner-role only; the action re-checks on submit as a tamper
  // defense.
  const candidateIds = await listAccessibleDocoIdsForPrincipal(me.id);
  type DocoRow = {
    id: string;
    handle: string;
    my_role: DocoRole;
    org_id: string | null;
    org_label: string | null;
  };
  const candidates = await Promise.all(
    candidateIds.map(async (id): Promise<DocoRow | null> => {
      const d = await getDocoById(id);
      if (!d) return null;
      const my_role = await getDocoLevelRole({ ownerId: d.owner_id, docoId: d.id }, me.id);
      if (my_role !== "owner") return null;
      const org_id = d.owner_id.startsWith("organization_") ? d.owner_id : null;
      // owner_slug resolves to the owning org's handle for org-owned
      // Docos; it labels the picker bucket so a Doco you own under an
      // org you don't is grouped by name instead of orphaned.
      const org_label = org_id ? d.owner_slug || null : null;
      return { id: d.id, handle: d.handle, my_role, org_id, org_label };
    }),
  );
  let docos = candidates
    .filter((d): d is DocoRow => d !== null)
    .sort((a, b) => a.handle.localeCompare(b.handle));

  // Targeted-grant focus: if the client passed `target_doco_handle`
  // on the device-authorization request, narrow the picker to JUST
  // that Doco. Falls back to the full owned-Docos list when the
  // user doesn't own the requested target (we surface a notice in
  // that case so they know what was requested).
  let targetedMessage: string | null = null;
  if (row.target_doco_handle) {
    const matched = docos.filter((d) => d.handle === row.target_doco_handle);
    if (matched.length > 0) {
      docos = matched;
    } else {
      targetedMessage = `The token requested access to "${row.target_doco_handle}" but you don't own that Doco — pick from the Docos you do own below, or ask the client to target a different one.`;
    }
  }

  const requestedRole: DocoRole | null =
    row.requested_role &&
    (["reader", "writer", "owner"] as const).includes(row.requested_role as DocoRole)
      ? (row.requested_role as DocoRole)
      : null;

  // Orgs the user owns. Approving an org grants access to every Doco
  // it owns now AND any Doco created under it later. Hidden when the
  // client narrowed the picker to a single target Doco — org-wide
  // approval would defeat that narrowing.
  type OrgRow = { id: string; handle: string; display_name: string; my_role: DocoRole };
  let orgs: OrgRow[] = [];
  if (!row.target_doco_handle) {
    const owned = await listOrgsOwnedOrAdminedBy(me.id);
    const enriched = await Promise.all(
      owned.map(async (o): Promise<OrgRow | null> => {
        const role = await getOrgRole(o.id, me.id);
        if (role !== "owner") return null;
        return { id: o.id, handle: o.handle, display_name: o.display_name, my_role: role };
      }),
    );
    orgs = enriched
      .filter((o): o is OrgRow => o !== null)
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  return {
    user_code,
    stage: "approve" as const,
    client_name: client?.client_name ?? row.client_id.slice(0, 20),
    docos,
    orgs,
    target_doco_handle: row.target_doco_handle,
    requested_role: requestedRole,
    targeted_message: targetedMessage,
    me,
  };
}

export async function action({ request }: { request: Request }) {
  const form = await request.formData();
  const user_code = String(form.get("user_code") ?? "")
    .trim()
    .toUpperCase();
  const decision = String(form.get("decision") ?? "");

  // "enter-code" form posts here with just user_code → bounce to GET
  // so the loader does the sign-in + lookup dance.
  if (!decision) {
    if (!user_code) {
      throw new Response("user_code required", { status: 400 });
    }
    return redirect(`/device?user_code=${encodeURIComponent(user_code)}`);
  }

  const principal = await getCurrentPrincipal(request);
  if (!principal) throw new Response("not signed in", { status: 401 });

  const row = await getDeviceAuthorizationByUserCode(user_code);
  if (!row) throw new Response("unknown user_code", { status: 404 });
  if (row.expires_at.getTime() <= Date.now()) {
    return redirect(`/device?user_code=${encodeURIComponent(user_code)}`);
  }

  if (decision === "deny") {
    await denyDeviceAuthorization(row.device_code);
    return redirect(`/device?user_code=${encodeURIComponent(user_code)}`);
  }

  if (decision === "approve") {
    const tokenName = String(form.get("token_name") ?? "").trim();
    if (!tokenName) {
      throw new Response("token_name required", { status: 400 });
    }
    const grants = await readOAuthApprovalGrants(form, principal.id);
    await approveDeviceAuthorization({
      device_code: row.device_code,
      approver_user_id: principal.id,
      token_name: tokenName,
      granted_doco_ids: grants.granted_doco_ids,
      granted_doco_roles: grants.granted_doco_roles,
      granted_doco_write_types: grants.granted_doco_write_types,
      granted_org_ids: grants.granted_org_ids,
      granted_org_roles: grants.granted_org_roles,
      granted_org_write_types: grants.granted_org_write_types,
    });
    return redirect(`/device?user_code=${encodeURIComponent(user_code)}`);
  }

  throw new Response(`unknown decision: ${decision}`, { status: 400 });
}

export function meta() {
  return [{ title: "Authorize token access · Doco" }];
}

export default function DevicePage() {
  const data = useLoaderData() as LoaderData;
  return (
    <div>
      <SiteHeader me={data.me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb items={[{ label: "Home", to: "/" }, { label: "Authorize device" }]} />
        <Card>{renderStage(data)}</Card>
      </SingleColumnPageMain>
    </div>
  );
}

function renderStage(data: LoaderData) {
  if (data.stage === "enter-code") {
    return (
      <>
        <CardHeader>
          <CardTitle>Authorize token access</CardTitle>
          <CardDescription>
            Enter the short code your client showed you. It looks like{" "}
            <code className="rounded bg-input px-1 py-0.5 text-xs">WXYZ-1234</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-3">
            <input
              type="text"
              name="user_code"
              autoComplete="off"
              spellCheck={false}
              placeholder="WXYZ-1234"
              className="block w-full rounded-md px-3 py-2 font-mono text-xl uppercase tracking-widest text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <button
              type="submit"
              className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
            >
              Continue
            </button>
          </Form>
        </CardContent>
      </>
    );
  }
  if (data.stage === "approve") {
    const docos = data.docos ?? [];
    const orgs = data.orgs ?? [];
    return (
      <>
        <CardHeader>
          <CardTitle>Authorize token access</CardTitle>
          <CardDescription>
            <strong>{data.client_name}</strong> wants access to your Docos. Name the token, then
            pick individual Docos or grant access to an entire organization — code{" "}
            <code className="rounded bg-input px-1 py-0.5 text-xs">{data.user_code}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {docos.length === 0 && orgs.length === 0 ? (
            <p className="text-sm text-destructive">
              You don't own any Docos or organizations. Only owners can grant token access — create
              one first, then re-enter this code.
            </p>
          ) : (
            <OAuthAccessApprovalForm
              docos={docos}
              orgs={orgs}
              tokenNamePlaceholder="e.g. Codex in Doco repo"
              requestedRole={data.requested_role ?? null}
              targetedMessage={data.targeted_message ?? null}
              approveLabel="Approve"
              cancelLabel="Deny"
              cancelDecisionValue="deny"
              hiddenFields={{ user_code: data.user_code }}
            />
          )}
        </CardContent>
      </>
    );
  }
  // done / expired / denied / unknown
  return (
    <>
      <CardHeader>
        <CardTitle>Authorize token access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p
          className={data.stage === "done" ? "text-sm text-foreground" : "text-sm text-destructive"}
        >
          {data.message}
        </p>
        {data.stage === "done" ? <CloudEnvNote /> : null}
        <a href="/device" className="text-sm text-primary hover:underline">
          Enter a different code
        </a>
      </CardContent>
    </>
  );
}

/**
 * After a device approval, clients that run in ephemeral cloud sandboxes
 * (Claude Code on the web, Codespaces, …) would re-prompt on every fresh
 * container. Point the user at a non-rotating cloud token they can pin in
 * the environment's variable config so new instances inherit access.
 */
function CloudEnvNote() {
  return (
    <div
      className="rounded-md border border-border bg-muted/40 p-3 text-sm space-y-1.5"
      data-testid="device-cloud-env-note"
    >
      <p className="font-semibold">Is this client running in a cloud environment?</p>
      <p className="text-muted-foreground">
        If it runs in an ephemeral cloud sandbox (Claude Code on the web, Codespaces, Replit…), each
        fresh instance would otherwise ask you to approve it again. To grant access once and have
        new instances inherit it automatically, mint a non-rotating{" "}
        <a href="/api-keys" className="font-semibold text-primary hover:underline">
          cloud access token
        </a>{" "}
        and add <code className="rounded bg-input px-1 py-0.5 text-xs">DOCO_REFRESH</code> +{" "}
        <code className="rounded bg-input px-1 py-0.5 text-xs">DOCO_CLIENT_ID</code> to the
        environment's variable configuration.
      </p>
    </div>
  );
}
