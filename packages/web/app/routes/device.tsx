// GET + POST /device — human-facing landing page for the Device
// Authorization Grant (RFC 8628).
//
// The flow the user walks through:
//   1. Their agent shows them a short code (e.g. "WXYZ-1234") and tells
//      them to open https://doco.to/device.
//   2. They land here, prefilled if the agent passed
//      verification_uri_complete (?user_code=...), otherwise they type
//      the code into the form.
//   3. If they're not signed in, we redirect through GitHub OAuth and
//      come back with the user_code preserved as a query param.
//   4. The post-sign-in screen shows the agent's name + a list of
//      Docos they own/admin/are granted access to; they pick which to
//      grant, click Approve, and we mark the device-authorization row
//      approved. The agent's next poll at /oauth/token mints + receives
//      the access token.
//   5. Cancel marks the row denied; the agent's next poll gets
//      access_denied and stops.

import type { DocoRole } from "@doco/db";
import { getOrgRole } from "@doco/db";
import { useState } from "react";
import { Form, redirect, useLoaderData } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { getDocoById } from "~/lib/db.server";
import { getDocoLevelRole, listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";
import { listOrgsOwnedOrAdminedBy } from "~/lib/host.server";
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  getClient,
  getDeviceAuthorizationByUserCode,
} from "~/lib/oauth-server.server";
import { DOCO_ROLES } from "~/lib/role-helpers";
import { getCurrentPrincipal } from "~/lib/session.server";

interface LoaderData {
  user_code: string;
  stage: "enter-code" | "approve" | "done" | "expired" | "denied" | "unknown";
  client_name?: string;
  docos?: {
    id: string;
    handle: string;
    my_role: DocoRole;
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
      message: "We don't recognize this code. Double-check what your agent showed you.",
      me,
    };
  }
  if (row.expires_at.getTime() <= Date.now()) {
    return {
      user_code,
      stage: "expired" as const,
      message: "This code has expired. Ask your agent to start a new device authorization.",
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
  // Only owners can grant agent access (approvers/authors/readers
  // can't extend access). Filter the candidate Doco list to
  // owner-role only; the action re-checks on submit as a tamper
  // defense.
  const candidateIds = await listAccessibleDocoIdsForPrincipal(me.id);
  type DocoRow = { id: string; handle: string; my_role: DocoRole };
  const candidates = await Promise.all(
    candidateIds.map(async (id): Promise<DocoRow | null> => {
      const d = await getDocoById(id);
      if (!d) return null;
      const my_role = await getDocoLevelRole({ ownerId: d.owner_id, docoId: d.id }, me.id);
      if (my_role !== "owner") return null;
      return { id: d.id, handle: d.handle, my_role };
    }),
  );
  let docos = candidates
    .filter((d): d is DocoRow => d !== null)
    .sort((a, b) => a.handle.localeCompare(b.handle));

  // Targeted-grant focus: if the agent passed `target_doco_handle`
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
      targetedMessage = `The agent requested access to "${row.target_doco_handle}" but you don't own that Doco — pick from the Docos you do own below, or ask the agent to target a different one.`;
    }
  }

  const requestedRole: DocoRole | null =
    row.requested_role &&
    (["reader", "author", "approver", "owner"] as const).includes(row.requested_role as DocoRole)
      ? (row.requested_role as DocoRole)
      : null;

  // Orgs the user owns. Approving an org grants access to every Doco
  // it owns now AND any Doco created under it later. Hidden when the
  // agent narrowed the picker to a single target Doco — org-wide
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
    const agentName = String(form.get("agent_name") ?? "").trim();
    if (!agentName) {
      throw new Response("agent_name required", { status: 400 });
    }
    const selected = form.getAll("doco_id").map((v) => String(v));
    const selectedOrgs = form.getAll("org_id").map((v) => String(v));
    if (selected.length === 0 && selectedOrgs.length === 0) {
      throw new Response("at least one Doco or organization must be selected", { status: 400 });
    }
    // Defense against form tampering. Two checks per id:
    //   1. Principal must hold OWNER on this Doco — only owners can
    //      grant agent access.
    //   2. The per-Doco role from the form must be a valid DocoRole.
    const granted_doco_roles: Record<string, DocoRole> = {};
    const allowed = new Set(await listAccessibleDocoIdsForPrincipal(principal.id));
    for (const id of selected) {
      if (!allowed.has(id)) {
        throw new Response(`not authorized for ${id}`, { status: 403 });
      }
      const doco = await getDocoById(id);
      if (!doco) throw new Response(`unknown doco: ${id}`, { status: 400 });
      const myRole = await getDocoLevelRole(
        { ownerId: doco.owner_id, docoId: doco.id },
        principal.id,
      );
      if (myRole !== "owner") {
        throw new Response(
          `Only owners can grant access; you hold '${myRole ?? "no role"}' on ${doco.handle}.`,
          { status: 403 },
        );
      }
      const raw = String(form.get(`role_${id}`) ?? "owner").toLowerCase();
      const requested = (DOCO_ROLES as string[]).includes(raw) ? (raw as DocoRole) : "owner";
      granted_doco_roles[id] = requested;
    }
    // Org-level grants. Same defense-against-tampering shape: re-check
    // OWNER on each org and validate the role is a real DocoRole.
    const granted_org_roles: Record<string, DocoRole> = {};
    for (const orgId of selectedOrgs) {
      if (!orgId.startsWith("organization_")) {
        throw new Response(`invalid org id: ${orgId}`, { status: 400 });
      }
      const myOrgRole = await getOrgRole(orgId, principal.id);
      if (myOrgRole !== "owner") {
        throw new Response(
          `Only org owners can grant access; you hold '${myOrgRole ?? "no role"}' on ${orgId}.`,
          { status: 403 },
        );
      }
      const raw = String(form.get(`role_org_${orgId}`) ?? "owner").toLowerCase();
      const requested = (DOCO_ROLES as string[]).includes(raw) ? (raw as DocoRole) : "owner";
      granted_org_roles[orgId] = requested;
    }
    await approveDeviceAuthorization({
      device_code: row.device_code,
      approver_user_id: principal.id,
      agent_name: agentName,
      granted_doco_ids: selected,
      granted_doco_roles,
      granted_org_ids: selectedOrgs,
      granted_org_roles,
    });
    return redirect(`/device?user_code=${encodeURIComponent(user_code)}`);
  }

  throw new Response(`unknown decision: ${decision}`, { status: 400 });
}

export function meta() {
  return [{ title: "Authorize agent access · Doco" }];
}

export default function DevicePage() {
  const data = useLoaderData() as LoaderData;
  return (
    <div>
      <SiteHeader mode="host" me={data.me} />
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
          <CardTitle>Authorize agent access</CardTitle>
          <CardDescription>
            Enter the short code your agent showed you. It looks like{" "}
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
          <CardTitle>Authorize agent access</CardTitle>
          <CardDescription>
            <strong>{data.client_name}</strong> wants access to your Docos. Name the agent, then
            pick individual Docos or grant access to an entire organization — code{" "}
            <code className="rounded bg-input px-1 py-0.5 text-xs">{data.user_code}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {docos.length === 0 && orgs.length === 0 ? (
            <p className="text-sm text-destructive">
              You don't own any Docos or organizations. Only owners can grant agent access — create
              one first, then re-enter this code.
            </p>
          ) : (
            <DevicePickerForm
              userCode={data.user_code}
              docos={docos}
              orgs={orgs}
              requestedRole={data.requested_role ?? null}
              targetedMessage={data.targeted_message ?? null}
              focused={Boolean(data.target_doco_handle && docos.length === 1)}
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
        <CardTitle>Authorize agent access</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p
          className={data.stage === "done" ? "text-sm text-foreground" : "text-sm text-destructive"}
        >
          {data.message}
        </p>
        <a href="/device" className="text-sm text-primary hover:underline">
          Enter a different code
        </a>
      </CardContent>
    </>
  );
}

/**
 * Controlled approve form for /device. Per-Doco AND per-org
 * checkboxes + role dropdowns plus bulk controls. Mirrors the same
 * shape on /oauth/authorize.
 */
function DevicePickerForm({
  userCode,
  docos,
  orgs,
  requestedRole,
  targetedMessage,
  focused,
}: {
  userCode: string;
  docos: { id: string; handle: string; my_role: DocoRole }[];
  orgs: { id: string; handle: string; display_name: string; my_role: DocoRole }[];
  requestedRole: DocoRole | null;
  targetedMessage: string | null;
  focused: boolean;
}) {
  // When the agent requested a specific role, prefill the per-Doco
  // role dropdowns to that — otherwise default to the user's actual
  // role on each Doco (always "owner" here, since the loader
  // filtered to owner-only).
  const defaultRole = (d: { my_role: DocoRole }): DocoRole => requestedRole ?? d.my_role;
  // Default selection: Docos pre-selected (existing behavior), orgs
  // un-selected (org-wide grants are broader → require explicit opt-in).
  const [selected, setSelected] = useState<Set<string>>(() => new Set(docos.map((d) => d.id)));
  const [roles, setRoles] = useState<Record<string, DocoRole>>(() =>
    Object.fromEntries(docos.map((d) => [d.id, defaultRole(d)])),
  );
  const [selectedOrgs, setSelectedOrgs] = useState<Set<string>>(() => new Set());
  const [orgRoles, setOrgRoles] = useState<Record<string, DocoRole>>(() =>
    Object.fromEntries(orgs.map((o) => [o.id, defaultRole(o)])),
  );
  const [agentName, setAgentName] = useState("");
  const allDocosSelected = docos.length > 0 && selected.size === docos.length;
  const noneDocosSelected = selected.size === 0;
  const allOrgsSelected = orgs.length > 0 && selectedOrgs.size === orgs.length;
  const noneOrgsSelected = selectedOrgs.size === 0;
  const nothingSelected = selected.size === 0 && selectedOrgs.size === 0;
  const missingAgentName = agentName.trim().length === 0;
  return (
    <Form method="post" className="space-y-4">
      <input type="hidden" name="user_code" value={userCode} />

      <label className="block text-sm">
        <span className="block text-xs uppercase tracking-wide text-muted-foreground mb-1">
          Agent name
        </span>
        <input
          type="text"
          name="agent_name"
          value={agentName}
          onChange={(e) => setAgentName(e.currentTarget.value)}
          required
          maxLength={120}
          placeholder="e.g. Codex in Doco repo"
          className="block w-full max-w-md rounded-md px-3 py-2 text-sm"
        />
      </label>

      {targetedMessage ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {targetedMessage}
        </p>
      ) : null}

      {/* Organizations picker. Approving an org grants the agent
          access to every Doco the org owns now AND any Doco created
          under it later. Hidden in focused mode (agent targeted one
          Doco) — org-wide would defeat the narrowing. */}
      {!focused && orgs.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-foreground">Organizations</h3>
          <p className="text-xs text-muted-foreground">
            Approving an organization grants access to every Doco it owns, including ones added
            later.
          </p>
          <div className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2">
            <button
              type="button"
              onClick={() => setSelectedOrgs(new Set(orgs.map((o) => o.id)))}
              disabled={allOrgsSelected}
              className="neu-button rounded-md px-2.5 py-1 text-xs font-semibold text-foreground disabled:opacity-50"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={() => setSelectedOrgs(new Set())}
              disabled={noneOrgsSelected}
              className="neu-button rounded-md px-2.5 py-1 text-xs font-semibold text-foreground disabled:opacity-50"
            >
              Deselect all
            </button>
            <span className="text-xs text-muted-foreground">
              {selectedOrgs.size} of {orgs.length} selected
            </span>
            <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
              Set all roles to:
              <select
                aria-label="Set all org roles"
                defaultValue=""
                onChange={(e) => {
                  const r = e.currentTarget.value as DocoRole | "";
                  if (!r) return;
                  setOrgRoles(Object.fromEntries(orgs.map((o) => [o.id, r])));
                  e.currentTarget.value = "";
                }}
                className="rounded-md px-2 py-1 text-xs text-foreground"
              >
                <option value="" disabled>
                  choose…
                </option>
                {DOCO_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <ul className="neu-surface divide-y divide-border rounded-md bg-card">
            {orgs.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <label className="flex flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selectedOrgs.has(o.id)}
                    onChange={(e) => {
                      const next = new Set(selectedOrgs);
                      if (e.currentTarget.checked) next.add(o.id);
                      else next.delete(o.id);
                      setSelectedOrgs(next);
                    }}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="text-sm">
                    <strong className="font-semibold">{o.handle}</strong>
                    {o.display_name && o.display_name !== o.handle ? (
                      <span className="text-muted-foreground"> · {o.display_name}</span>
                    ) : null}
                  </span>
                </label>
                <select
                  aria-label={`Role on ${o.handle}`}
                  value={orgRoles[o.id] ?? o.my_role}
                  onChange={(e) =>
                    setOrgRoles({ ...orgRoles, [o.id]: e.currentTarget.value as DocoRole })
                  }
                  disabled={!selectedOrgs.has(o.id)}
                  className="rounded-md px-2 py-1 text-xs text-foreground disabled:opacity-50"
                >
                  {DOCO_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Docos picker. Bulk controls are hidden in focused mode
          (agent targeted one Doco). */}
      {docos.length > 0 ? (
        <section className="space-y-2">
          {!focused && orgs.length > 0 ? (
            <h3 className="text-sm font-semibold text-foreground">Docos</h3>
          ) : null}
          {!focused ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md px-3 py-2">
              <button
                type="button"
                onClick={() => setSelected(new Set(docos.map((d) => d.id)))}
                disabled={allDocosSelected}
                className="neu-button rounded-md px-2.5 py-1 text-xs font-semibold text-foreground disabled:opacity-50"
              >
                Select all
              </button>
              <button
                type="button"
                onClick={() => setSelected(new Set())}
                disabled={noneDocosSelected}
                className="neu-button rounded-md px-2.5 py-1 text-xs font-semibold text-foreground disabled:opacity-50"
              >
                Deselect all
              </button>
              <span className="text-xs text-muted-foreground">
                {selected.size} of {docos.length} selected
              </span>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                Set all roles to:
                <select
                  aria-label="Set all roles"
                  defaultValue=""
                  onChange={(e) => {
                    const r = e.currentTarget.value as DocoRole | "";
                    if (!r) return;
                    setRoles(Object.fromEntries(docos.map((d) => [d.id, r])));
                    e.currentTarget.value = "";
                  }}
                  className="rounded-md px-2 py-1 text-xs text-foreground"
                >
                  <option value="" disabled>
                    choose…
                  </option>
                  {DOCO_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </span>
            </div>
          ) : null}
          <ul className="neu-surface divide-y divide-border rounded-md bg-card">
            {docos.map((d) => (
              <li key={d.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <label className="flex flex-1 cursor-pointer items-center gap-3">
                  <input
                    type="checkbox"
                    checked={selected.has(d.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.currentTarget.checked) next.add(d.id);
                      else next.delete(d.id);
                      setSelected(next);
                    }}
                    className="h-4 w-4 accent-primary"
                  />
                  <span className="text-sm">
                    <strong className="font-semibold">{d.handle}</strong>
                  </span>
                </label>
                <select
                  aria-label={`Role on ${d.handle}`}
                  value={roles[d.id] ?? d.my_role}
                  onChange={(e) =>
                    setRoles({ ...roles, [d.id]: e.currentTarget.value as DocoRole })
                  }
                  disabled={!selected.has(d.id)}
                  className="rounded-md px-2 py-1 text-xs text-foreground disabled:opacity-50"
                >
                  {DOCO_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {Array.from(selected).map((id) => (
        <input key={id} type="hidden" name="doco_id" value={id} />
      ))}
      {Array.from(selected).map((id) => (
        <input key={`role_${id}`} type="hidden" name={`role_${id}`} value={roles[id] ?? "owner"} />
      ))}
      {Array.from(selectedOrgs).map((id) => (
        <input key={`org_${id}`} type="hidden" name="org_id" value={id} />
      ))}
      {Array.from(selectedOrgs).map((id) => (
        <input
          key={`role_org_${id}`}
          type="hidden"
          name={`role_org_${id}`}
          value={orgRoles[id] ?? "owner"}
        />
      ))}

      <p className="text-[11px] text-muted-foreground">
        Lower a Doco's or org's role to scope the agent down (e.g. give a research agent{" "}
        <code>reader</code> only). Owners can grant any role up to and including their own.
      </p>

      <div className="flex gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={nothingSelected || missingAgentName}
          className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          className="neu-button rounded-md px-4 py-2 text-sm font-semibold text-foreground"
        >
          Deny
        </button>
      </div>
    </Form>
  );
}
