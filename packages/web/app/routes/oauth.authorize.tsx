// GET + POST /oauth/authorize — the user-facing authorize endpoint.
//
// Flow:
//   1. Runtime opens this URL in the user's browser with PKCE params.
//   2. If user not signed in, redirect through GitHub OAuth (the
//      return path captures the exact authorize URL so params survive).
//   3. Render the approve UI: a list of every Doco the user can read
//      or write (the union of direct ownership, org membership, and
//      doco_users grants), with checkboxes.
//   4. POST from the form mints an authorization code (with PKCE
//      challenge + selected docos baked in) and redirects to the
//      runtime's `redirect_uri` with ?code=...&state=...
//   5. Cancel → redirect with ?error=access_denied&state=...

import type { DocoRole } from "@doco/db";
import { useState } from "react";
import { Form, redirect, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal,
} from "~/lib/doco-access.server";
import { getClient, issueAuthorizationCode } from "~/lib/oauth-server.server";
import { getDocoById } from "~/lib/db.server";
import { DOCO_ROLES } from "~/lib/role-helpers";
import { getCurrentPrincipal } from "~/lib/session";

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string | null;
  scope: string | null;
  /** Optional. Doco handle the agent wants access to — focuses the picker. */
  target_doco_handle: string | null;
  /** Optional. Pre-fills the per-Doco role dropdown(s). */
  requested_role: string | null;
}

interface LoaderData {
  client_name: string;
  params: AuthorizeParams;
  docos: {
    id: string;
    handle: string;
    name: string | null;
    my_role: DocoRole;
  }[];
  targeted_message: string | null;
  me: Awaited<ReturnType<typeof getCurrentPrincipal>>;
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const params = readParams(url);
  const paramError = validateParams(params);
  if (paramError) throw errorResponse(paramError, 400);

  const client = await getClient(params.client_id);
  if (!client) throw errorResponse("invalid_client: unknown client_id", 400);
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    throw errorResponse("invalid_redirect_uri: not registered for this client", 400);
  }

  const principal = await getCurrentPrincipal(request);
  if (!principal) {
    const returnPath = `${url.pathname}${url.search}`;
    throw redirect(`/auth/github?return=${encodeURIComponent(returnPath)}`);
  }

  // Only owners can grant agent access. Approvers / authors / readers
  // can't extend access to others — that's a permissions delegation
  // only owners get to do. So we filter the candidate Doco list down
  // to ones where the principal holds owner role (direct, via org, or
  // via doco_users grant). The action below re-checks this on submit
  // (defense against form tampering).
  const candidateIds = await listAccessibleDocoIdsForPrincipal(principal.id);
  type DocoRow = { id: string; handle: string; name: string | null; my_role: DocoRole };
  const candidates = await Promise.all(
    candidateIds.map(async (id): Promise<DocoRow | null> => {
      const d = await getDocoById(id);
      if (!d) return null;
      const my_role = await getDocoLevelRole(
        { ownerId: d.owner_id, docoId: d.id },
        principal.id,
      );
      if (my_role !== "owner") return null;
      return { id: d.id, handle: d.handle, name: d.name, my_role };
    }),
  );
  let docos = candidates
    .filter((d): d is DocoRow => d !== null)
    .sort((a, b) => a.handle.localeCompare(b.handle));

  // Targeted-grant focus. If the runtime asked for a specific Doco
  // (e.g. read from the project's DOCO.md), narrow the picker to
  // just that Doco. If the user doesn't own the requested target,
  // we fall back to the full owned list + surface a notice.
  let targetedMessage: string | null = null;
  if (params.target_doco_handle) {
    const matched = docos.filter((d) => d.handle === params.target_doco_handle);
    if (matched.length > 0) {
      docos = matched;
    } else {
      targetedMessage = `The agent requested access to "${params.target_doco_handle}" but you don't own that Doco — pick from the Docos you do own below, or have the agent target a different one.`;
    }
  }

  const data: LoaderData = {
    client_name: client.client_name ?? client.client_id.slice(0, 20),
    params,
    docos,
    targeted_message: targetedMessage,
    me: principal,
  };
  return data;
}

export async function action({ request }: { request: Request }) {
  const url = new URL(request.url);
  const params = readParams(url);
  const paramError = validateParams(params);
  if (paramError) throw errorResponse(paramError, 400);

  const principal = await getCurrentPrincipal(request);
  if (!principal) throw errorResponse("user not signed in", 401);

  const client = await getClient(params.client_id);
  if (!client) throw errorResponse("invalid_client", 400);
  if (!client.redirect_uris.includes(params.redirect_uri)) {
    throw errorResponse("invalid_redirect_uri", 400);
  }

  const form = await request.formData();
  if (form.get("decision") === "cancel") {
    return redirect(redirectWith(params, { error: "access_denied" }));
  }

  const selected = form.getAll("doco_id").map((v) => String(v));
  if (selected.length === 0) {
    throw errorResponse("at least one Doco must be selected", 400);
  }
  // Defense against form tampering. Two checks per selected id:
  //   1. Principal must hold OWNER on this Doco — only owners can
  //      grant agent access (approvers/authors/readers cannot).
  //   2. The per-Doco role on the form must be a valid DocoRole.
  //      Since owners hold all roles, the cap is always "owner";
  //      we still validate the value to reject garbage.
  const granted_doco_roles: Record<string, DocoRole> = {};
  const allowed = new Set(await listAccessibleDocoIdsForPrincipal(principal.id));
  for (const id of selected) {
    if (!allowed.has(id)) throw errorResponse(`not authorized for ${id}`, 403);
    const doco = await getDocoById(id);
    if (!doco) throw errorResponse(`unknown doco: ${id}`, 400);
    const myRole = await getDocoLevelRole(
      { ownerId: doco.owner_id, docoId: doco.id },
      principal.id,
    );
    if (myRole !== "owner") {
      throw errorResponse(
        `Only owners can grant access; you hold '${myRole ?? "no role"}' on ${doco.handle}.`,
        403,
      );
    }
    const raw = String(form.get(`role_${id}`) ?? "owner").toLowerCase();
    const requested = (DOCO_ROLES as string[]).includes(raw) ? (raw as DocoRole) : "owner";
    granted_doco_roles[id] = requested;
  }

  const { code } = await issueAuthorizationCode({
    client_id: params.client_id,
    principal_id: principal.id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    granted_doco_ids: selected,
    granted_doco_roles,
    scope: params.scope ?? undefined,
  });
  // OAuth 2.1 §4.1.2: 302 to redirect_uri with ?code=...&state=...
  // The runtime's local listener catches it and renders its own
  // "you can return to your terminal" page.
  return redirect(redirectWith(params, { code }));
}

export function meta() {
  return [{ title: "Approve Doco access · Doco" }];
}

export default function AuthorizePage() {
  const data = useLoaderData() as LoaderData;
  return (
    <div>
      <SiteHeader mode="host" me={data.me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Approve Doco access</CardTitle>
            <CardDescription>
              <strong>{data.client_name}</strong> wants access to your Docos. Only Docos you own
              are shown.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.docos.length === 0 ? (
              <p className="text-sm text-destructive">
                You don't own any Docos yet. Only Doco owners can grant agent access — create a
                Doco first, then return to this page.
              </p>
            ) : (
              <DocoPickerForm
                docos={data.docos}
                requestedRole={(data.params.requested_role as DocoRole | null) ?? null}
                targetedMessage={data.targeted_message}
                focused={Boolean(data.params.target_doco_handle && data.docos.length === 1)}
              />
            )}
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}

/**
 * Controlled form for the Doco picker: per-Doco checkboxes + role
 * dropdowns, plus bulk controls (select / deselect all + set all
 * roles). Submit serializes the controlled state through hidden
 * fields so the server-side parser stays unchanged.
 */
function DocoPickerForm({
  docos,
  requestedRole,
  targetedMessage,
  focused,
}: {
  docos: { id: string; handle: string; name: string | null; my_role: DocoRole }[];
  requestedRole: DocoRole | null;
  targetedMessage: string | null;
  focused: boolean;
}) {
  // When the runtime requested a specific role (via ?requested_role=…),
  // pre-fill the dropdown to that. Otherwise default to the user's
  // actual role on each Doco (always "owner" here — the loader
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
    // reloadDocument: the action returns a 302 to the runtime's
    // localhost callback. Client-side fetch can't follow cross-origin
    // redirects; a native document POST + browser-followed 302 can.
    <Form method="post" reloadDocument className="space-y-3">
      {targetedMessage ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {targetedMessage}
        </p>
      ) : null}

      {/* Bulk controls — hidden in focused mode (agent targeted one Doco). */}
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
          <li
            key={d.id}
            className="flex items-center justify-between gap-3 px-3 py-2.5"
          >
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

      {/* Hidden inputs serializing the controlled state to the
          server-side action. Same field names the action already
          parses (doco_id[], role_<id>). */}
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
          value="cancel"
          className="rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-input"
        >
          Cancel
        </button>
      </div>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function readParams(url: URL): AuthorizeParams {
  const requested = (url.searchParams.get("requested_role") ?? "").toLowerCase();
  return {
    response_type: url.searchParams.get("response_type") ?? "",
    client_id: url.searchParams.get("client_id") ?? "",
    redirect_uri: url.searchParams.get("redirect_uri") ?? "",
    code_challenge: url.searchParams.get("code_challenge") ?? "",
    code_challenge_method: url.searchParams.get("code_challenge_method") ?? "",
    state: url.searchParams.get("state"),
    scope: url.searchParams.get("scope"),
    target_doco_handle: url.searchParams.get("target_doco_handle"),
    requested_role:
      requested && ["reader", "author", "approver", "owner"].includes(requested)
        ? requested
        : null,
  };
}

function validateParams(p: AuthorizeParams): string | null {
  if (p.response_type !== "code") return "response_type must be 'code'";
  if (!p.client_id) return "client_id required";
  if (!p.redirect_uri) return "redirect_uri required";
  if (!p.code_challenge) return "code_challenge required (PKCE mandatory)";
  if (p.code_challenge_method !== "S256") return "code_challenge_method must be 'S256'";
  return null;
}

function redirectWith(params: AuthorizeParams, extras: Record<string, string>): string {
  const url = new URL(params.redirect_uri);
  for (const [k, v] of Object.entries(extras)) url.searchParams.set(k, v);
  if (params.state) url.searchParams.set("state", params.state);
  return url.toString();
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

