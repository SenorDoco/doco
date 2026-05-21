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
import { useState } from "react";
import { Form, redirect, useLoaderData } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { getDocoById } from "~/lib/db.server";
import {
  getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal,
} from "~/lib/doco-access.server";
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  getClient,
  getDeviceAuthorizationByUserCode,
} from "~/lib/oauth-server.server";
import { DOCO_ROLES } from "~/lib/role-helpers";
import { getCurrentPrincipal } from "~/lib/session";

interface LoaderData {
  user_code: string;
  stage: "enter-code" | "approve" | "done" | "expired" | "denied" | "unknown";
  client_name?: string;
  docos?: {
    id: string;
    handle: string;
    name: string | null;
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
  type DocoRow = { id: string; handle: string; name: string | null; my_role: DocoRole };
  const candidates = await Promise.all(
    candidateIds.map(async (id): Promise<DocoRow | null> => {
      const d = await getDocoById(id);
      if (!d) return null;
      const my_role = await getDocoLevelRole(
        { ownerId: d.owner_id, docoId: d.id },
        me.id,
      );
      if (my_role !== "owner") return null;
      return { id: d.id, handle: d.handle, name: d.name, my_role };
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
    (["reader", "author", "approver", "owner"] as const).includes(
      row.requested_role as DocoRole,
    )
      ? (row.requested_role as DocoRole)
      : null;

  return {
    user_code,
    stage: "approve" as const,
    client_name: client?.client_name ?? row.client_id.slice(0, 20),
    docos,
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
    const selected = form.getAll("doco_id").map((v) => String(v));
    if (selected.length === 0) {
      throw new Response("at least one Doco must be selected", { status: 400 });
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
    await approveDeviceAuthorization({
      device_code: row.device_code,
      principal_id: principal.id,
      granted_doco_ids: selected,
      granted_doco_roles,
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
        <Breadcrumb
          items={[
            { label: "Home", to: "/" },
            { label: "Authorize device" },
          ]}
        />
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
              autoFocus
              autoComplete="off"
              spellCheck={false}
              placeholder="WXYZ-1234"
              className="block w-full rounded-md border border-border bg-input px-3 py-2 font-mono text-xl uppercase tracking-widest text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
            />
            <button
              type="submit"
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Continue
            </button>
          </Form>
        </CardContent>
      </>
    );
  }
  if (data.stage === "approve") {
    return (
      <>
        <CardHeader>
          <CardTitle>Authorize agent access</CardTitle>
          <CardDescription>
            <strong>{data.client_name}</strong> wants access to your Docos. Pick which Docos it
            can read and write — code{" "}
            <code className="rounded bg-input px-1 py-0.5 text-xs">{data.user_code}</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data.docos && data.docos.length === 0 ? (
            <p className="text-sm text-destructive">
              You don't own any Docos. Only Doco owners can grant agent access — create a Doco
              first, then re-enter this code.
            </p>
          ) : (
            <DevicePickerForm
              userCode={data.user_code}
              docos={data.docos!}
              requestedRole={data.requested_role ?? null}
              targetedMessage={data.targeted_message ?? null}
              focused={Boolean(data.target_doco_handle && data.docos!.length === 1)}
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
 * Controlled approve form for /device. Per-Doco checkboxes + role
 * dropdowns plus bulk controls (select / deselect all + set all
 * roles). Mirrors the same shape on /oauth/authorize.
 */
function DevicePickerForm({
  userCode,
  docos,
  requestedRole,
  targetedMessage,
  focused,
}: {
  userCode: string;
  docos: { id: string; handle: string; name: string | null; my_role: DocoRole }[];
  requestedRole: DocoRole | null;
  targetedMessage: string | null;
  focused: boolean;
}) {
  // When the agent requested a specific role, prefill the per-Doco
  // role dropdowns to that — otherwise default to the user's actual
  // role on each Doco (always "owner" here, since the loader
  // filtered to owner-only).
  const defaultRole = (d: { my_role: DocoRole }): DocoRole =>
    requestedRole ?? d.my_role;
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(docos.map((d) => d.id)),
  );
  const [roles, setRoles] = useState<Record<string, DocoRole>>(
    () => Object.fromEntries(docos.map((d) => [d.id, defaultRole(d)])),
  );
  const allSelected = selected.size === docos.length;
  const noneSelected = selected.size === 0;
  return (
    <Form method="post" className="space-y-3">
      <input type="hidden" name="user_code" value={userCode} />

      {targetedMessage ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {targetedMessage}
        </p>
      ) : null}

      {/* Bulk controls — only useful when the picker shows multiple
          Docos. Hidden in focused mode (agent targeted one Doco). */}
      {focused ? null : (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-input/40 px-3 py-2">
          <button
            type="button"
            onClick={() => setSelected(new Set(docos.map((d) => d.id)))}
            disabled={allSelected}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-input disabled:opacity-50"
          >
            Select all
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            disabled={noneSelected}
            className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-semibold text-foreground hover:bg-input disabled:opacity-50"
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
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
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
      )}

      <ul className="divide-y divide-border rounded-md border border-border">
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
                {d.name && d.name !== d.handle ? (
                  <span className="text-muted-foreground"> · {d.name}</span>
                ) : null}
              </span>
            </label>
            <select
              aria-label={`Role on ${d.handle}`}
              value={roles[d.id] ?? d.my_role}
              onChange={(e) => setRoles({ ...roles, [d.id]: e.currentTarget.value as DocoRole })}
              disabled={!selected.has(d.id)}
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground disabled:opacity-50"
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

      {Array.from(selected).map((id) => (
        <input key={id} type="hidden" name="doco_id" value={id} />
      ))}
      {Array.from(selected).map((id) => (
        <input
          key={`role_${id}`}
          type="hidden"
          name={`role_${id}`}
          value={roles[id] ?? "owner"}
        />
      ))}

      <p className="text-[11px] text-muted-foreground">
        Lower a Doco's role to scope the agent down (e.g. give a research agent{" "}
        <code>reader</code> only). Owners can grant any role up to and including their own.
      </p>

      <div className="flex gap-2">
        <button
          type="submit"
          name="decision"
          value="approve"
          disabled={selected.size === 0}
          className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          Approve
        </button>
        <button
          type="submit"
          name="decision"
          value="deny"
          className="rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-input"
        >
          Deny
        </button>
      </div>
    </Form>
  );
}
