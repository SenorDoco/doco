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
//      Docos they own; they pick which to grant, click Approve, and
//      we mark the device-authorization row approved. The agent's
//      next poll at /oauth/token mints + receives the access token.
//   5. Cancel marks the row denied; the agent's next poll gets
//      access_denied and stops.
//
// This route never sees the agent — only the human. The agent's only
// touchpoints are POST /oauth/device_authorization (to start) and
// POST /oauth/token (to poll).

import { getDocoById, listDocoIdsForUserPrincipal } from "@doco/db";
import { Form, redirect, useLoaderData } from "react-router";
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  getClient,
  getDeviceAuthorizationByUserCode,
} from "~/lib/oauth-server.server";
import { getCurrentPrincipal } from "~/lib/session";

interface LoaderData {
  user_code: string;
  stage: "enter-code" | "approve" | "done" | "expired" | "denied" | "unknown";
  client_name?: string;
  docos?: { id: string; handle: string; name: string | null }[];
  message?: string;
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const user_code = (url.searchParams.get("user_code") ?? "").trim().toUpperCase();

  // No code yet → blank form, no sign-in required.
  if (!user_code) {
    return { user_code: "", stage: "enter-code" as const };
  }

  const row = await getDeviceAuthorizationByUserCode(user_code);
  if (!row) {
    return {
      user_code,
      stage: "unknown" as const,
      message: "We don't recognize this code. Double-check what your agent showed you.",
    };
  }
  if (row.expires_at.getTime() <= Date.now()) {
    return {
      user_code,
      stage: "expired" as const,
      message: "This code has expired. Ask your agent to start a new device authorization.",
    };
  }
  if (row.status === "denied") {
    return {
      user_code,
      stage: "denied" as const,
      message: "This authorization was already denied.",
    };
  }
  if (row.status === "approved") {
    return {
      user_code,
      stage: "done" as const,
      message:
        "You already approved this agent. It should pick up its access on its next poll (within a few seconds).",
    };
  }

  // status === 'pending'. Require sign-in before showing the approve UI.
  const principal = await getCurrentPrincipal(request);
  if (!principal) {
    // Preserve the user_code through the sign-in round-trip so we land
    // back on the approve screen.
    const returnPath = `/device?user_code=${encodeURIComponent(user_code)}`;
    throw redirect(`/auth/github?return=${encodeURIComponent(returnPath)}`);
  }

  const client = await getClient(row.client_id);
  const docoIds = await listDocoIdsForUserPrincipal(principal.id);
  const docos = (
    await Promise.all(
      docoIds.map(async (id) => {
        const d = await getDocoById(id);
        return d ? { id: d.id, handle: d.handle, name: d.name } : null;
      }),
    )
  ).filter((d): d is { id: string; handle: string; name: string | null } => d !== null);

  return {
    user_code,
    stage: "approve" as const,
    client_name: client?.client_name ?? row.client_id.slice(0, 20),
    docos,
  };
}

export async function action({ request }: { request: Request }) {
  const url = new URL(request.url);
  const form = await request.formData();
  const user_code = String(form.get("user_code") ?? "")
    .trim()
    .toUpperCase();
  const decision = String(form.get("decision") ?? "");

  // "enter-code" form posts here with just user_code → bounce to GET so
  // the loader does the sign-in + lookup dance.
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
    // Defense against form tampering — every selected id must be in
    // the signed-in user's grant set.
    const allowed = new Set(await listDocoIdsForUserPrincipal(principal.id));
    for (const id of selected) {
      if (!allowed.has(id)) {
        throw new Response(`not authorized for ${id}`, { status: 403 });
      }
    }
    await approveDeviceAuthorization({
      device_code: row.device_code,
      principal_id: principal.id,
      granted_doco_ids: selected,
    });
    return redirect(`/device?user_code=${encodeURIComponent(user_code)}`);
  }

  throw new Response(`unknown decision: ${decision}`, { status: 400 });
}

export default function DevicePage() {
  const data = useLoaderData() as LoaderData;
  return (
    <main style={{ maxWidth: 560, margin: "60px auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24, marginBottom: 16 }}>Authorize agent access</h1>
      {renderStage(data)}
    </main>
  );
}

function renderStage(data: LoaderData) {
  if (data.stage === "enter-code") {
    return (
      <>
        <p style={{ color: "#555", marginBottom: 16 }}>
          Enter the short code your agent showed you. It looks like <code>WXYZ-1234</code>.
        </p>
        <Form method="post">
          <input
            type="text"
            name="user_code"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="WXYZ-1234"
            style={{
              padding: "10px 12px",
              fontSize: 20,
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              fontFamily: "monospace",
              width: "100%",
              boxSizing: "border-box",
              borderRadius: 6,
              border: "1px solid #ccc",
              marginBottom: 12,
            }}
          />
          <button
            type="submit"
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
            Continue
          </button>
        </Form>
      </>
    );
  }
  if (data.stage === "approve") {
    return (
      <>
        <p style={{ color: "#555", marginBottom: 8 }}>
          <strong>{data.client_name}</strong> wants access to your Docos.
        </p>
        <p style={{ color: "#888", marginBottom: 24, fontSize: 14 }}>
          Code: <code>{data.user_code}</code>
        </p>
        {data.docos && data.docos.length === 0 ? (
          <p style={{ color: "#a00" }}>
            You don't have access to any Docos yet. Create one or accept an invite first, then come
            back to this code.
          </p>
        ) : (
          <Form method="post">
            <input type="hidden" name="user_code" value={data.user_code} />
            <ul style={{ listStyle: "none", padding: 0, marginBottom: 24 }}>
              {data.docos!.map((d) => (
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
                value="deny"
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
                Deny
              </button>
            </div>
          </Form>
        )}
      </>
    );
  }
  // done / expired / denied / unknown
  return (
    <div>
      <p style={{ color: data.stage === "done" ? "#070" : "#a00", marginBottom: 16 }}>
        {data.message}
      </p>
      <a href="/device" style={{ color: "#0066cc" }}>
        Enter a different code
      </a>
    </div>
  );
}
