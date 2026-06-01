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
import { getOrgRole } from "@doco/db";
import { redirect, useLoaderData } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { OAuthAccessApprovalForm } from "~/components/oauth-access-approval-form";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { getDocoById } from "~/lib/db.server";
import { getDocoLevelRole, listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";
import { listOrgsOwnedOrAdminedBy } from "~/lib/host.server";
import { readOAuthApprovalGrants } from "~/lib/oauth-approval-grants.server";
import { getClient, issueAuthorizationCode } from "~/lib/oauth-server.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface AuthorizeParams {
  response_type: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  code_challenge_method: string;
  state: string | null;
  scope: string | null;
  /** Optional. Doco handle the token wants access to — focuses the picker. */
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
    my_role: DocoRole;
    // The org that owns this Doco (owner_id === organization_…), or
    // null when the user owns it directly. Drives the picker grouping.
    org_id: string | null;
    // The owning org's handle, so the picker can label that org's
    // bucket even when the user isn't a member of it.
    org_label: string | null;
  }[];
  orgs: {
    id: string;
    handle: string;
    display_name: string;
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

  // Only owners can grant token access. Approvers / authors / readers
  // can't extend access to others — that's a permissions delegation
  // only owners get to do. So we filter the candidate Doco list down
  // to ones where the principal holds owner role (direct, via org, or
  // via doco_users grant). The action below re-checks this on submit
  // (defense against form tampering).
  const candidateIds = await listAccessibleDocoIdsForPrincipal(principal.id);
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
      const my_role = await getDocoLevelRole({ ownerId: d.owner_id, docoId: d.id }, principal.id);
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
      targetedMessage = `The token requested access to "${params.target_doco_handle}" but you don't own that Doco — pick from the Docos you do own below, or have the client target a different one.`;
    }
  }

  // Orgs the user owns. Approving an org grants the token access to
  // every Doco the org owns (live — including Docos created under it
  // after the token is minted). Hidden when the client narrowed the
  // picker to a single target Doco; org approval would defeat that
  // narrowing.
  type OrgRow = { id: string; handle: string; display_name: string; my_role: DocoRole };
  let orgs: OrgRow[] = [];
  if (!params.target_doco_handle) {
    const owned = await listOrgsOwnedOrAdminedBy(principal.id);
    const enriched = await Promise.all(
      owned.map(async (o): Promise<OrgRow | null> => {
        const role = await getOrgRole(o.id, principal.id);
        if (role !== "owner") return null;
        return { id: o.id, handle: o.handle, display_name: o.display_name, my_role: role };
      }),
    );
    orgs = enriched
      .filter((o): o is OrgRow => o !== null)
      .sort((a, b) => a.display_name.localeCompare(b.display_name));
  }

  const data: LoaderData = {
    client_name: client.client_name ?? client.client_id.slice(0, 20),
    params,
    docos,
    orgs,
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

  const tokenName = String(form.get("token_name") ?? "").trim();
  if (!tokenName) throw errorResponse("token_name required", 400);

  const grants = await readOAuthApprovalGrants(form, principal.id);

  const { code } = await issueAuthorizationCode({
    client_id: params.client_id,
    approver_user_id: principal.id,
    token_name: tokenName,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    granted_doco_ids: grants.granted_doco_ids,
    granted_doco_roles: grants.granted_doco_roles,
    granted_doco_write_types: grants.granted_doco_write_types,
    granted_org_ids: grants.granted_org_ids,
    granted_org_roles: grants.granted_org_roles,
    granted_org_write_types: grants.granted_org_write_types,
    scope: params.scope ?? undefined,
  });
  // OAuth 2.1 §4.1.2 expects a 302 straight to redirect_uri with
  // ?code=...&state=... — we 302 to /oauth/approved first, which
  // paints a Doco-branded "Access approved" card and then meta-
  // refreshes to the runtime's localhost listener. Without that step
  // users land on an unstyled `localhost:53682/callback` page with no
  // visual confirmation that their approval took effect on Doco.
  //
  // /oauth/approved validates the `to=` URL against the auth code
  // it carries, so it can't be repurposed as an open redirect.
  const runtimeRedirect = redirectWith(params, { code });
  const approvedUrl = `/oauth/approved?to=${encodeURIComponent(runtimeRedirect)}`;
  return redirect(approvedUrl);
}

export function meta() {
  return [{ title: "Approve access · Doco" }];
}

export default function AuthorizePage() {
  const data = useLoaderData() as LoaderData;
  return (
    <div>
      <SiteHeader me={data.me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb items={[{ label: "Home", to: "/" }, { label: "Approve access" }]} />
        <Card>
          <CardHeader>
            <CardTitle>Approve access</CardTitle>
            <CardDescription>
              <strong>{data.client_name}</strong> wants access to your docos. Name the token, then
              pick orgs and docos you own.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.docos.length === 0 && data.orgs.length === 0 ? (
              <p className="text-sm text-destructive">
                You don't own any Docos or organizations yet. Only owners can grant token access —
                create one first, then return to this page.
              </p>
            ) : (
              <OAuthAccessApprovalForm
                docos={data.docos}
                orgs={data.orgs}
                tokenNamePlaceholder="e.g. Claude Code in repo"
                requestedRole={(data.params.requested_role as DocoRole | null) ?? null}
                targetedMessage={data.targeted_message}
                approveLabel="Approve"
                cancelLabel="Cancel"
                cancelDecisionValue="cancel"
              />
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
      requested && ["reader", "writer", "owner"].includes(requested) ? requested : null,
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
