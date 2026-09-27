// GET + POST /oauth/authorize — the user-facing authorize endpoint.
//
// Flow:
//   1. Runtime opens this URL in the user's browser with PKCE params.
//   2. If user not signed in, redirect through GitHub OAuth (the
//      return path captures the exact authorize URL so params survive).
//   3. Render the approve UI: a list of every Doco the user can read
//      or write (the union of direct ownership, workspace membership, and
//      doco_users grants), with checkboxes.
//   4. POST from the form mints an authorization code (with PKCE
//      challenge + selected docos baked in) and redirects to the
//      runtime's `redirect_uri` with ?code=...&state=...
//   5. Cancel → redirect with ?error=access_denied&state=...

import type { DocoRole } from "@doco/db";
import { redirect, useLoaderData } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { OAuthAccessApprovalForm } from "~/components/oauth-access-approval-form";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  type ApprovalDocoOption,
  type ApprovalWorkspaceOption,
  approvalTargetNotOwnedMessage,
  boundWorkspaceNotOwnedMessage,
  parseWorkspaceFromResource,
  resolveApprovalGrantView,
  scopeApprovalToBoundWorkspace,
} from "~/lib/approval-grants";
import {
  loadApprovalGrantOptions,
  readOAuthApprovalGrants,
} from "~/lib/oauth-approval-grants.server";
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
  /** RFC 8707 resource the connector authorizes against (verbatim). */
  resource: string | null;
  /** Workspace the connector scoped consent to, parsed from a workspace `resource`. */
  bound_workspace_id: string | null;
}

interface LoaderData {
  client_name: string;
  params: AuthorizeParams;
  docos: ApprovalDocoOption[];
  workspaces: ApprovalWorkspaceOption[];
  // When set, the client requested a Doco the user doesn't own — render
  // only the terminal not-owned message instead of the picker.
  blockedTargetHandle: string | null;
  // When set, the connector is bound to a single workspace: the form skips the
  // multi-workspace picker and just asks for an access level on this workspace.
  boundWorkspace: { id: string; label: string; maxRole: DocoRole } | null;
  // When set, the connector is bound to a workspace the user doesn't own —
  // render the terminal "not owned" message instead of the picker.
  boundWorkspaceBlockedId: string | null;
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

  // The approve picker offers everything the signed-in user can grant —
  // owner-tier workspaces and Docos (the action re-checks owner on submit as a
  // tamper defense). Targeting a Doco the user owns (or targeting
  // nothing) yields the identical matrix as /device; targeting a Doco
  // they don't own blocks with a terminal message.
  const client_name = client.client_name ?? client.client_id.slice(0, 20);
  const { docos, workspaces } = await loadApprovalGrantOptions(principal.id);

  // Workspace-scoped resource: the connector authorized against one workspace's
  // resource, so the consent must cover ONLY that workspace — never the
  // approver's others. Scope to it (or block when the approver doesn't own it).
  if (params.bound_workspace_id) {
    const scoped = scopeApprovalToBoundWorkspace(docos, workspaces, params.bound_workspace_id);
    return {
      client_name,
      params,
      docos: scoped.blocked ? [] : scoped.docos,
      workspaces: scoped.blocked ? [] : scoped.workspaces,
      blockedTargetHandle: null,
      boundWorkspace: scoped.blocked
        ? null
        : {
            id: scoped.boundWorkspace.id,
            label: scoped.boundWorkspace.display_name || scoped.boundWorkspace.handle,
            maxRole: scoped.boundWorkspace.my_role,
          },
      boundWorkspaceBlockedId: scoped.blocked ? scoped.workspaceId : null,
      me: principal,
    } satisfies LoaderData;
  }

  const view = resolveApprovalGrantView(docos, workspaces, params.target_doco_handle);
  return {
    client_name,
    params,
    docos: view.blocked ? [] : view.docos,
    workspaces: view.blocked ? [] : view.workspaces,
    blockedTargetHandle: view.blocked ? view.targetDocoHandle : null,
    boundWorkspace: null,
    boundWorkspaceBlockedId: null,
    me: principal,
  } satisfies LoaderData;
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

  // A bound connector may only grant within its own workspace — the whole
  // workspace, or specific Docos inside it. The picker already hides the
  // others, but re-check on submit (against the authoritative scoped options)
  // so a tampered POST can't bind the token to a different workspace or a Doco
  // outside it.
  if (params.bound_workspace_id) {
    // An actor ("all workspaces") credential spans every workspace; a connector
    // bound to a single workspace must never mint one.
    if (grants.grant_type === "actor") {
      throw errorResponse("invalid_scope: a workspace connector can't mint an actor token", 400);
    }
    const { docos, workspaces } = await loadApprovalGrantOptions(principal.id);
    const scoped = scopeApprovalToBoundWorkspace(docos, workspaces, params.bound_workspace_id);
    if (scoped.blocked) {
      throw errorResponse("invalid_scope: you don't own the connector's workspace", 403);
    }
    const allowedWorkspaceIds = new Set([scoped.boundWorkspace.id]);
    const allowedDocoIds = new Set(scoped.docos.map((d) => d.id));
    const outside =
      grants.granted_workspace_ids.some((id) => !allowedWorkspaceIds.has(id)) ||
      grants.granted_doco_ids.some((id) => !allowedDocoIds.has(id));
    if (outside) {
      throw errorResponse("invalid_scope: this connector can only grant its own workspace", 400);
    }
  }

  const { code } = await issueAuthorizationCode({
    client_id: params.client_id,
    approver_user_id: principal.id,
    token_name: tokenName,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    granted_doco_ids: grants.granted_doco_ids,
    granted_doco_roles: grants.granted_doco_roles,
    granted_doco_write_types: grants.granted_doco_write_types,
    granted_workspace_ids: grants.granted_workspace_ids,
    granted_workspace_roles: grants.granted_workspace_roles,
    granted_workspace_write_types: grants.granted_workspace_write_types,
    grant_type: grants.grant_type,
    actor_role: grants.actor_role,
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
            {data.blockedTargetHandle || data.boundWorkspaceBlockedId ? null : (
              <CardDescription>
                {data.boundWorkspace ? (
                  <>
                    An agent is requesting access to your{" "}
                    <strong>{data.boundWorkspace.label}</strong> workspace through{" "}
                    <strong>{data.client_name}</strong>. Name the token and choose the access level.
                  </>
                ) : (
                  <>
                    An agent is requesting access to your docos through{" "}
                    <strong>{data.client_name}</strong>. Name the token and choose how much access
                    to grant.
                  </>
                )}
              </CardDescription>
            )}
          </CardHeader>
          <CardContent>
            {data.blockedTargetHandle ? (
              <p className="text-sm text-destructive">
                {approvalTargetNotOwnedMessage(data.blockedTargetHandle)}
              </p>
            ) : data.boundWorkspaceBlockedId ? (
              <p className="text-sm text-destructive">
                {boundWorkspaceNotOwnedMessage(data.boundWorkspaceBlockedId)}
              </p>
            ) : (
              <OAuthAccessApprovalForm
                docos={data.docos}
                workspaces={data.workspaces}
                boundWorkspace={data.boundWorkspace ?? undefined}
                tokenNamePlaceholder="e.g. Claude Code in repo"
                requestedRole={(data.params.requested_role as DocoRole | null) ?? null}
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
  const resource = url.searchParams.get("resource");
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
    resource,
    bound_workspace_id: parseWorkspaceFromResource(resource),
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
