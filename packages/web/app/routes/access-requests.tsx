// /access-requests — the owner's inbox of pending access requests. Approve
// (writes a doco_users grant; the requester's existing connector token, which
// defers to the matrix, gains access on its next call — no re-auth) or deny.
// Also the landing for a just-sent request. Requesting is available to agents
// via the doco_request_access MCP tool and to humans via the private-doco 403
// page, both of which funnel into the same access_requests table.

import { redirect, useLoaderData } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  type OwnerInboxItem,
  approveAccessRequest,
  denyAccessRequest,
  listAccessRequestsForOwner,
  requestDocoAccess,
} from "~/lib/access-requests.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface LoaderData {
  me: Awaited<ReturnType<typeof getCurrentPrincipal>>;
  inbox: OwnerInboxItem[];
  sent: string | null;
}

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    const url = new URL(request.url);
    throw redirect(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  const inbox = await listAccessRequestsForOwner(me.id);
  const sent = new URL(request.url).searchParams.get("sent");
  return { me, inbox, sent };
}

export async function action({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "request") {
    const doco = String(form.get("doco") ?? "").trim();
    const rawRole = String(form.get("role") ?? "reader")
      .trim()
      .toLowerCase();
    const role = rawRole === "writer" || rawRole === "owner" ? rawRole : "reader";
    const reason = String(form.get("reason") ?? "").trim() || null;
    await requestDocoAccess({
      docoHandleOrId: doco,
      requesterId: me.id,
      requestedRole: role,
      reason,
    });
    return redirect(`/access-requests?sent=${encodeURIComponent(doco)}`);
  }

  const id = String(form.get("id") ?? "");
  if (intent === "approve") await approveAccessRequest({ id, approverId: me.id });
  else if (intent === "deny") await denyAccessRequest({ id, approverId: me.id });
  return redirect("/access-requests");
}

export function meta() {
  return [{ title: "Access requests · Doco" }];
}

export default function AccessRequestsPage() {
  const { me, inbox, sent } = useLoaderData() as LoaderData;
  return (
    <div>
      <SiteHeader me={me} />
      <SingleColumnPageMain className="py-6 space-y-4">
        <PageHeader
          breadcrumb={[{ label: "Home", to: "/" }, { label: "Access requests" }]}
          title="Access requests"
        />
        {sent ? (
          <Card>
            <CardContent>
              <p className="text-sm">
                Request sent to the owners of <span className="font-mono">{sent}</span>. Once an
                owner approves, your access applies on your next request — no reconnect.
              </p>
            </CardContent>
          </Card>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Pending requests</CardTitle>
          </CardHeader>
          <CardContent>
            {inbox.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No one is waiting on access to your Docos.
              </p>
            ) : (
              <ul className="space-y-3">
                {inbox.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3 last:border-0"
                  >
                    <div className="text-sm">
                      <span className="font-medium">{r.requester_login}</span> wants{" "}
                      <span className="font-mono">{r.requested_role}</span> on{" "}
                      <span className="font-mono">{r.doco_handle}</span>
                      {r.reason ? (
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          “{r.reason}”
                        </span>
                      ) : null}
                    </div>
                    <div className="flex gap-2">
                      <form method="post">
                        <input type="hidden" name="intent" value="approve" />
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-3 py-1.5 text-xs font-semibold"
                        >
                          Approve {r.requested_role}
                        </button>
                      </form>
                      <form method="post">
                        <input type="hidden" name="intent" value="deny" />
                        <input type="hidden" name="id" value={r.id} />
                        <button
                          type="submit"
                          className="neu-button rounded-md px-3 py-1.5 text-xs font-semibold text-foreground"
                        >
                          Deny
                        </button>
                      </form>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
