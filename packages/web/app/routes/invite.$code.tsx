// /invite/<code> — landing page for a doco invite. The same URL is
// shareable with humans and agents. Signed-in humans can accept here;
// signed-out users choose human sign-in or the plain-text agent recipe
// at /invite/<code>/agent.txt.
//
// The page loads the invite and shows the human what they're being
// invited to (Doco handle + expiration):
//
//   - If signed in: "Accept invite" joins them to what it grants
//     (lib/invite.server acceptInvite) and takes them there. Joining a
//     workspace starts its one onboarding step for them (ask your agent to
//     start using Doco), which the workspace keeps them on until it's done.
//   - If not signed in: ask whether the visitor is human or agent. Humans
//     sign in with GitHub, which accepts the invite on the way back
//     (routes/auth.github.callback.tsx), so they land in what it grants;
//     agents get the plain-text instructions for redeeming the same invite.

import { getUserById } from "@doco/db";
import { Form, Link, redirect } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { HowDocoWorks } from "~/components/how-doco-works";
import { PageMain } from "~/components/page-main";
import { rootDir } from "~/lib/db.server";
import { InviteStore } from "~/lib/invite-store.server";
import { acceptInvite, inviteTarget } from "~/lib/invite.server";
import { getCurrentPrincipal } from "~/lib/session.server";

type LoaderError =
  | { error: "missing_code" }
  | { error: "not_found" }
  | { error: "expired" }
  | { error: "consumed" }
  | { error: "revoked" }
  | { error: "doco_not_found" }
  | { error: "workspace_not_found" };

type LoaderOk = {
  ok: true;
  code: string;
  target: { level: "doco" | "workspace"; label: string };
  inviter: { username: string } | null;
  expires_at: string;
  signedIn: { id: string; username: string } | null;
};

export async function loader({ request, params }: { request: Request; params: { code: string } }) {
  const code = (params.code ?? "").trim();
  if (!code) return { error: "missing_code" } satisfies LoaderError;

  const store = InviteStore.forDoco(rootDir());
  const invite = await store.findInvite(code);
  if (!invite) return { error: "not_found" } satisfies LoaderError;
  if (invite.status === "expired") return { error: "expired" } satisfies LoaderError;
  if (invite.status === "consumed") return { error: "consumed" } satisfies LoaderError;
  if (invite.status === "revoked") return { error: "revoked" } satisfies LoaderError;

  const target = await inviteTarget(invite);
  if (!target) return { error: "doco_not_found" } satisfies LoaderError;

  const inviter = invite.minted_by_user_id ? await getUserById(invite.minted_by_user_id) : null;
  const principal = await getCurrentPrincipal(request);
  return {
    ok: true,
    code,
    target: { level: target.level, label: target.label },
    inviter: inviter ? { username: inviter.github_login ?? inviter.id } : null,
    expires_at: invite.expires_at,
    signedIn: principal ? { id: principal.id, username: principal.username } : null,
  } satisfies LoaderOk;
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { code: string };
}): Promise<{ error: string } | Response> {
  const principal = await getCurrentPrincipal(request);
  if (!principal) {
    const ret = `/invite/${encodeURIComponent(params.code)}`;
    return redirect(`/auth/github?return=${encodeURIComponent(ret)}`);
  }

  const code = (params.code ?? "").trim();
  if (!code) return { error: "Missing invite code." };
  const accepted = await acceptInvite(code, principal.id);
  return "error" in accepted ? accepted : redirect(accepted.to);
}

export function meta() {
  return [{ title: "Join a doco · Doco" }];
}

export default function InviteLanding({
  loaderData,
  actionData,
}: {
  loaderData: LoaderOk | LoaderError;
  actionData?: { error: string };
}) {
  if ("error" in loaderData) {
    return (
      <InviteMain>
        <Card>
          <CardHeader>
            <CardTitle>{errorTitle(loaderData.error)}</CardTitle>
            <CardDescription>{errorDescription(loaderData.error)}</CardDescription>
          </CardHeader>
        </Card>
      </InviteMain>
    );
  }

  return (
    <InviteMain>
      <Card>
        <CardHeader>
          <CardTitle>
            You've been invited to {loaderData.target.level === "workspace" ? "workspace" : "doco"}{" "}
            <em>{loaderData.target.label}</em>
            {loaderData.inviter ? (
              <>
                {" "}
                by <em>{loaderData.inviter.username}</em>
              </>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Invite expires <strong>{new Date(loaderData.expires_at).toLocaleString()}</strong>.
            Single-use — once you accept, this URL stops working.
          </p>
          {loaderData.signedIn ? (
            <>
              <p>
                You're signed in as <strong>{loaderData.signedIn.username}</strong>.
              </p>
              {actionData ? <p className="text-destructive">{actionData.error}</p> : null}
              <Form method="post" className="flex gap-2">
                <button
                  type="submit"
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Accept invite
                </button>
                <Link to="/" className="neu-button rounded-md px-4 py-2 text-sm font-semibold">
                  Decline
                </Link>
              </Form>
            </>
          ) : (
            <>
              <p>Who is redeeming this invite?</p>
              <div className="grid gap-2 sm:grid-cols-2">
                <Link
                  to={`/auth/github?return=${encodeURIComponent(`/invite/${loaderData.code}`)}`}
                  className="neu-button rounded-md bg-card p-3"
                >
                  <span className="block text-sm font-semibold">Human</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Sign in with GitHub to join.
                  </span>
                </Link>
                <Link
                  to={`/invite/${loaderData.code}/agent.txt`}
                  reloadDocument
                  className="neu-button rounded-md bg-card p-3"
                >
                  <span className="block text-sm font-semibold">Agent</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Open the plain-text redeem instructions.
                  </span>
                </Link>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <div className="pt-8">
        <HowDocoWorks />
      </div>
    </InviteMain>
  );
}

function errorTitle(err: LoaderError["error"]): string {
  if (err === "missing_code") return "No invite code in the URL";
  if (err === "not_found") return "Invite not found";
  if (err === "expired") return "Invite expired";
  if (err === "consumed") return "Invite already redeemed";
  if (err === "revoked") return "Invite revoked";
  if (err === "workspace_not_found") return "The workspace this invite pointed at no longer exists";
  return "The doco this invite pointed at no longer exists";
}

function errorDescription(err: LoaderError["error"]): string {
  if (err === "missing_code") return "Open the URL the inviter shared, not /invite/ on its own.";
  if (err === "not_found") return "This invite link doesn't match any active or past invite.";
  if (err === "expired") return "Ask the inviter for a fresh URL.";
  if (err === "consumed")
    return "This invite was used. Each invite URL is single-use; ask for a new one.";
  if (err === "revoked") return "The minter revoked this invite. Ask them for a fresh one.";
  if (err === "workspace_not_found") return "The workspace it pointed at has been deleted.";
  return "The doco it pointed at has been deleted.";
}

function InviteMain({ children }: { children: React.ReactNode }) {
  return (
    <PageMain className="py-12 space-y-4">
      <Breadcrumb items={[{ label: "Home", to: "/" }, { label: "Invite" }]} />
      {children}
    </PageMain>
  );
}
