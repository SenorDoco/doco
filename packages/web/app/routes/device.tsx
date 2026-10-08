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
//   4. The post-sign-in screen says what the agent will reach (by default
//      everything they can) and offers Allow, with Limit access opening the
//      grant picker (decision_01M4EQPJ6AKETJ1508W254DXVB). Allow marks the
//      device-authorization row approved; the client's next poll at
//      /oauth/token mints + receives the access token.
//   5. Cancel marks the row denied; the client's next poll gets
//      access_denied and stops.

import type { DocoRole } from "@doco/db";
import { Form, redirect, useLoaderData } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { OAuthAccessApprovalForm } from "~/components/oauth-access-approval-form";
import { PageMain } from "~/components/page-main";
import {
  type ApprovalDocoOption,
  type ApprovalWorkspaceOption,
  approvalTargetNotOwnedMessage,
  resolveApprovalGrantView,
} from "~/lib/approval-grants";
import {
  loadApprovalGrantOptions,
  readOAuthApprovalGrants,
} from "~/lib/oauth-approval-grants.server";
import {
  approveDeviceAuthorization,
  denyDeviceAuthorization,
  getClient,
  getDeviceAuthorizationByUserCode,
} from "~/lib/oauth-server.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface LoaderData {
  user_code: string;
  stage: "enter-code" | "approve" | "target-not-owned" | "done" | "expired" | "denied" | "unknown";
  client_name?: string;
  docos?: ApprovalDocoOption[];
  workspaces?: ApprovalWorkspaceOption[];
  target_doco_handle?: string | null;
  requested_role?: DocoRole | null;
  message?: string;
  me: Awaited<ReturnType<typeof getCurrentPrincipal>>;
}

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const user_code = (url.searchParams.get("user_code") ?? "").trim().toUpperCase();
  const me = await getCurrentPrincipal(request);

  if (!user_code) {
    return { user_code: "", stage: "enter-code" as const };
  }

  const row = await getDeviceAuthorizationByUserCode(user_code);
  if (!row) {
    return {
      user_code,
      stage: "unknown" as const,
      message: "That code isn't recognized. Double-check what your client showed you.",
    };
  }
  if (row.expires_at.getTime() <= Date.now()) {
    return {
      user_code,
      stage: "expired" as const,
      message: "This code has expired. Ask your client to start a new device authorization.",
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
      message: "Approved.",
    };
  }

  // status === 'pending'. Require sign-in before showing the approve UI.
  if (!me) {
    const returnPath = `/device?user_code=${encodeURIComponent(user_code)}`;
    throw redirect(`/auth/github?return=${encodeURIComponent(returnPath)}`);
  }

  const client = await getClient(row.client_id);
  // The approve picker offers everything the signed-in user can grant —
  // owner-tier workspaces and Docos (the action re-checks owner on submit as a
  // tamper defense). `target_doco_handle` never narrows this matrix; it
  // only drives the not-owned notice. Same builder + resolver as
  // /oauth/authorize, so both screens show the identical matrix.
  const { docos, workspaces } = await loadApprovalGrantOptions(me.id);
  const view = resolveApprovalGrantView(docos, workspaces, row.target_doco_handle);

  // The client asked for a doco the user doesn't own — nothing here can
  // satisfy that (granting a different Doco wouldn't help), so show only
  // the terminal not-owned message, no picker.
  if (view.blocked) {
    return {
      user_code,
      stage: "target-not-owned" as const,
      target_doco_handle: view.targetDocoHandle,
    };
  }

  const requestedRole: DocoRole | null =
    row.requested_role &&
    (["reader", "writer", "owner"] as const).includes(row.requested_role as DocoRole)
      ? (row.requested_role as DocoRole)
      : null;

  return {
    user_code,
    stage: "approve" as const,
    client_name: client?.client_name ?? row.client_id.slice(0, 20),
    docos: view.docos,
    workspaces: view.workspaces,
    requested_role: requestedRole,
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
    const grants = await readOAuthApprovalGrants(form, principal.id);
    await approveDeviceAuthorization({
      device_code: row.device_code,
      approver_user_id: principal.id,
      granted_doco_ids: grants.granted_doco_ids,
      granted_doco_roles: grants.granted_doco_roles,
      granted_doco_write_types: grants.granted_doco_write_types,
      granted_workspace_ids: grants.granted_workspace_ids,
      granted_workspace_roles: grants.granted_workspace_roles,
      granted_workspace_write_types: grants.granted_workspace_write_types,
      grant_type: grants.grant_type,
      actor_role: grants.actor_role,
    });
    return redirect(`/device?user_code=${encodeURIComponent(user_code)}`);
  }

  throw new Response(`unknown decision: ${decision}`, { status: 400 });
}

export function meta() {
  return [{ title: "Allow an agent · Doco" }];
}

export default function DevicePage() {
  const data = useLoaderData() as LoaderData;
  return (
    <PageMain className="py-8 space-y-4">
      <Breadcrumb items={[{ label: "Home", to: "/" }, { label: "Allow an agent" }]} />
      <Card>{renderStage(data)}</Card>
    </PageMain>
  );
}

function renderStage(data: LoaderData) {
  if (data.stage === "enter-code") {
    return (
      <>
        <CardHeader>
          <CardTitle>Allow an agent</CardTitle>
          <CardDescription>
            Enter the short code your agent showed you. It looks like{" "}
            <code className="rounded bg-input px-1 py-0.5">WXYZ-1234</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post" className="space-y-3">
            <input
              type="text"
              name="user_code"
              autoComplete="off"
              spellCheck={false}
              required
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
    return (
      <>
        <CardHeader>
          <CardTitle>Allow {data.client_name} to use Doco</CardTitle>
          <CardDescription>
            Code <code className="rounded bg-input px-1 py-0.5">{data.user_code}</code>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OAuthAccessApprovalForm
            clientName={data.client_name ?? "Your agent"}
            docos={data.docos ?? []}
            workspaces={data.workspaces ?? []}
            requestedRole={data.requested_role ?? null}
            cancelLabel="Deny"
            cancelDecisionValue="deny"
            hiddenFields={{ user_code: data.user_code }}
          />
        </CardContent>
      </>
    );
  }
  if (data.stage === "target-not-owned") {
    // Terminal: the client asked for a doco the user doesn't own. Show
    // only the explanation + call to action, no Allow.
    return (
      <>
        <CardHeader>
          <CardTitle>Allow an agent</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">
            {approvalTargetNotOwnedMessage(data.target_doco_handle ?? "")}
          </p>
        </CardContent>
      </>
    );
  }
  // done / expired / denied / unknown
  return (
    <>
      <CardHeader>
        <CardTitle>Allow an agent</CardTitle>
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
