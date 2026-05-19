// GET + POST /oauth/authorize — the user-facing authorize endpoint.
//
// Flow:
//   1. Runtime opens this URL in the user's browser with PKCE params.
//   2. If user not signed in, redirect through GitHub OAuth (the
//      return path captures the exact authorize URL so params survive).
//   3. Render the approve UI: a list of Docos the user owns, with
//      checkboxes. The runtime's name + the action ("wants access
//      to these Docos") frames what's being granted.
//   4. POST from the form mints an authorization code (with PKCE
//      challenge + selected docos baked in) and redirects to the
//      runtime's `redirect_uri` with ?code=...&state=...
//   5. Cancel → redirect with ?error=access_denied&state=...
//
// Params (per OAuth 2.1 §4.1.1):
//   response_type=code           (required, only value supported)
//   client_id                    (required)
//   redirect_uri                 (required; must match a registered URI)
//   code_challenge               (required, base64url)
//   code_challenge_method=S256   (required, only value supported)
//   state                        (recommended; opaque, round-tripped)
//   scope                        (optional)

import { getDocoById, listDocoIdsForUserPrincipal } from "@doco/db";
import { Form, redirect, useLoaderData } from "react-router";
import { getClient, issueAuthorizationCode } from "~/lib/oauth-server.server";
import { getCurrentPrincipal } from "~/lib/session";

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
  docos: { id: string; handle: string; name: string | null }[];
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
    // Bounce through GitHub. The state cookie is per-flow; we capture
    // the current authorize URL (with all PKCE params intact) in the
    // `return` cookie so the callback brings the user back here.
    const returnPath = `${url.pathname}${url.search}`;
    throw redirect(`/auth/github?return=${encodeURIComponent(returnPath)}`);
  }

  const docoIds = await listDocoIdsForUserPrincipal(principal.id);
  const docos = (
    await Promise.all(
      docoIds.map(async (id) => {
        const d = await getDocoById(id);
        return d ? { id: d.id, handle: d.handle, name: d.name } : null;
      }),
    )
  ).filter((d): d is { id: string; handle: string; name: string | null } => d !== null);

  const data: LoaderData = {
    client_name: client.client_name ?? client.client_id.slice(0, 20),
    params,
    docos,
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
  // Verify every selected doco_id is actually in the user's grant set
  // (defense against form tampering).
  const allowed = new Set(await listDocoIdsForUserPrincipal(principal.id));
  for (const id of selected) {
    if (!allowed.has(id)) throw errorResponse(`not authorized for ${id}`, 403);
  }

  const { code } = await issueAuthorizationCode({
    client_id: params.client_id,
    principal_id: principal.id,
    redirect_uri: params.redirect_uri,
    code_challenge: params.code_challenge,
    granted_doco_ids: selected,
    scope: params.scope ?? undefined,
  });
  return redirect(redirectWith(params, { code }));
}

export default function AuthorizePage() {
  const data = useLoaderData() as LoaderData;
  return (
    <main style={{ maxWidth: 560, margin: "60px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Approve Doco access</h1>
      <p style={{ color: "#555", marginBottom: 24 }}>
        <strong>{data.client_name}</strong> wants access to your Docos. Pick which Docos it can read
        and write to.
      </p>
      {data.docos.length === 0 ? (
        <p style={{ color: "#a00" }}>
          You don't have access to any Docos yet. Create one or accept an invite first, then return
          to this page.
        </p>
      ) : (
        <Form method="post" preventScrollReset>
          <ul style={{ listStyle: "none", padding: 0, marginBottom: 24 }}>
            {data.docos.map((d) => (
              <li key={d.id} style={{ padding: "12px 0", borderBottom: "1px solid #eee" }}>
                <label
                  style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer" }}
                >
                  <input type="checkbox" name="doco_id" value={d.id} defaultChecked />
                  <span>
                    <strong>{d.handle}</strong>
                    {d.name && d.name !== d.handle ? (
                      <span style={{ color: "#666" }}> · {d.name}</span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 12 }}>
            <button
              type="submit"
              name="decision"
              value="approve"
              style={{
                padding: "10px 20px",
                background: "#0066cc",
                color: "white",
                border: 0,
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 16,
              }}
            >
              Approve
            </button>
            <button
              type="submit"
              name="decision"
              value="cancel"
              style={{
                padding: "10px 20px",
                background: "#eee",
                color: "#333",
                border: 0,
                borderRadius: 6,
                cursor: "pointer",
                fontSize: 16,
              }}
            >
              Cancel
            </button>
          </div>
        </Form>
      )}
    </main>
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
