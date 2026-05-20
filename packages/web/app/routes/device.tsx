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

import { getDocoById } from "@doco/db";
import { Form, redirect, useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";
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
      message:
        "You already approved this agent. It should pick up its access on its next poll (within a few seconds).",
      me,
    };
  }

  // status === 'pending'. Require sign-in before showing the approve UI.
  if (!me) {
    const returnPath = `/device?user_code=${encodeURIComponent(user_code)}`;
    throw redirect(`/auth/github?return=${encodeURIComponent(returnPath)}`);
  }

  const client = await getClient(row.client_id);
  const docoIds = await listAccessibleDocoIdsForPrincipal(me.id);
  const docos = (
    await Promise.all(
      docoIds.map(async (id) => {
        const d = await getDocoById(id);
        return d ? { id: d.id, handle: d.handle, name: d.name } : null;
      }),
    )
  )
    .filter((d): d is { id: string; handle: string; name: string | null } => d !== null)
    .sort((a, b) => a.handle.localeCompare(b.handle));

  return {
    user_code,
    stage: "approve" as const,
    client_name: client?.client_name ?? row.client_id.slice(0, 20),
    docos,
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
    // Defense against form tampering — every selected id must be in
    // the principal's full accessible set (direct owner + org + grants).
    const allowed = new Set(await listAccessibleDocoIdsForPrincipal(principal.id));
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

export function meta() {
  return [{ title: "Authorize agent access · Doco" }];
}

export default function DevicePage() {
  const data = useLoaderData() as LoaderData;
  return (
    <div>
      <SiteHeader mode="host" me={data.me} />
      <SingleColumnPageMain className="py-8 space-y-4">
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
              You don't have access to any Docos yet. Create one or accept an invite first, then
              come back to this code.
            </p>
          ) : (
            <Form method="post" className="space-y-4">
              <input type="hidden" name="user_code" value={data.user_code} />
              <ul className="divide-y divide-border rounded-md border border-border">
                {data.docos!.map((d) => (
                  <li key={d.id} className="px-3 py-2.5">
                    <label className="flex cursor-pointer items-center gap-3">
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
                  </li>
                ))}
              </ul>
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
                  value="deny"
                  className="rounded-md border border-border bg-card px-4 py-2 text-sm font-semibold text-foreground hover:bg-input"
                >
                  Deny
                </button>
              </div>
            </Form>
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
