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

import { type DocoRole, ROLE_RANK, getDocoById, roleAtLeast } from "@doco/db";
import { Form, redirect, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  getDocoLevelRole,
  listAccessibleDocoIdsForPrincipal,
} from "~/lib/doco-access.server";
import { getClient, issueAuthorizationCode } from "~/lib/oauth-server.server";
import { getCurrentPrincipal } from "~/lib/session";

const DOCO_ROLES: DocoRole[] = ["reader", "author", "approver", "owner"];

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string | null;
  scope: string | null;
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

  // The full set the user could approve: direct owner + org + doco_users.
  // listAccessibleDocoIdsForPrincipal is the union; the bare
  // listDocoIdsForUserPrincipal helper sees only doco_users, which
  // misses Docos the user owns directly or via their org.
  const docoIds = await listAccessibleDocoIdsForPrincipal(principal.id);
  const docos = (
    await Promise.all(
      docoIds.map(async (id) => {
        const d = await getDocoById(id);
        if (!d) return null;
        const my_role =
          (await getDocoLevelRole({ ownerId: d.owner_id, docoId: d.id }, principal.id)) ?? "reader";
        return { id: d.id, handle: d.handle, name: d.name, my_role };
      }),
    )
  )
    .filter(
      (
        d,
      ): d is { id: string; handle: string; name: string | null; my_role: DocoRole } =>
        d !== null,
    )
    .sort((a, b) => a.handle.localeCompare(b.handle));

  const data: LoaderData = {
    client_name: client.client_name ?? client.client_id.slice(0, 20),
    params,
    docos,
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
  // Defense against form tampering: every selected id must be in
  // the principal's full accessible set, and the per-Doco role must
  // not exceed the principal's actual role on that Doco. Building
  // the cap table from `getDocoLevelRole` (the same union the picker
  // ran against) so we don't trust the form's role values.
  const granted_doco_roles: Record<string, DocoRole> = {};
  const allowed = new Set(await listAccessibleDocoIdsForPrincipal(principal.id));
  for (const id of selected) {
    if (!allowed.has(id)) throw errorResponse(`not authorized for ${id}`, 403);
    const doco = await getDocoById(id);
    if (!doco) throw errorResponse(`unknown doco: ${id}`, 400);
    const myRole =
      (await getDocoLevelRole({ ownerId: doco.owner_id, docoId: doco.id }, principal.id)) ??
      "reader";
    const raw = String(form.get(`role_${id}`) ?? myRole).toLowerCase();
    const requested = (DOCO_ROLES as string[]).includes(raw) ? (raw as DocoRole) : myRole;
    // Cap at the user's actual role — the user cannot grant more than
    // they themselves hold. min(requested, myRole).
    granted_doco_roles[id] = ROLE_RANK[requested] <= ROLE_RANK[myRole] ? requested : myRole;
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
              <strong>{data.client_name}</strong> wants access to your Docos. Pick which Docos it
              can read and write.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.docos.length === 0 ? (
              <p className="text-sm text-destructive">
                You don't have access to any Docos yet. Create one or accept an invite first,
                then return to this page.
              </p>
            ) : (
              <Form method="post" className="space-y-4">
                <ul className="divide-y divide-border rounded-md border border-border">
                  {data.docos.map((d) => (
                    <li
                      key={d.id}
                      className="flex items-center justify-between gap-3 px-3 py-2.5"
                    >
                      <label className="flex flex-1 cursor-pointer items-center gap-3">
                        <input
                          type="checkbox"
                          name="doco_id"
                          value={d.id}
                          defaultChecked
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
                        name={`role_${d.id}`}
                        defaultValue={d.my_role}
                        aria-label={`Role on ${d.handle}`}
                        className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
                      >
                        {DOCO_ROLES.filter((r) =>
                          roleAtLeast(d.my_role, r),
                        ).map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-muted-foreground">
                  Each Doco's dropdown is capped at the role you currently hold there. Lower it to
                  scope the agent down (e.g. give a research agent <code>reader</code> only).
                </p>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    name="decision"
                    value="approve"
                    className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
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
            )}
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function readParams(url: URL): AuthorizeParams {
  return {
    response_type: url.searchParams.get("response_type") ?? "",
    client_id: url.searchParams.get("client_id") ?? "",
    redirect_uri: url.searchParams.get("redirect_uri") ?? "",
    code_challenge: url.searchParams.get("code_challenge") ?? "",
    code_challenge_method: url.searchParams.get("code_challenge_method") ?? "",
    state: url.searchParams.get("state"),
    scope: url.searchParams.get("scope"),
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
