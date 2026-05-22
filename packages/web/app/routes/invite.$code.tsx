// /invite/<code> — landing page for a Doco invite. The same URL is
// shareable with humans and agents. Signed-in humans can accept here;
// signed-out users choose human sign-in or the plain-text agent recipe
// at /invite/<code>/agent.txt.
//
// The page loads the invite, shows the human what they're being
// invited to (Doco name + expiration), and asks them to click
// "Accept" only after they are signed in:
//
//   - If signed in: the invite is redeemed, the human Principal is
//     joined to the Doco or Organization. The success card is intentionally minimal —
//     just a "Continue" button to /<owner>/<slug>/.
//   - If not signed in: ask whether the visitor is human or agent. Humans
//     sign in and come back here to accept; agents get the plain-text
//     instructions for redeeming the same invite.

import {
  type DocoRole,
  getCollaboratorById,
  getDocoById,
  getPrincipalById,
  upsertDocoUser,
  upsertOrgUser,
} from "@doco/db";
import type { EntityId } from "@doco/shared";
import { Form, Link, redirect } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { rootDir } from "~/lib/db.server";
import { InviteStore } from "~/lib/invite-store.server";
import { getCurrentPrincipal } from "~/lib/session.server";

type LoaderError =
  | { error: "missing_code" }
  | { error: "not_found" }
  | { error: "expired" }
  | { error: "consumed" }
  | { error: "revoked" }
  | { error: "doco_not_found" };

type LoaderOk = {
  ok: true;
  code: string;
  doco: { id: string; handle: string };
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

  const doco = await getDocoById(invite.doco_id);
  if (!doco) return { error: "doco_not_found" } satisfies LoaderError;

  const inviter = invite.minted_by_collaborator_id
    ? await getCollaboratorById(invite.minted_by_collaborator_id)
    : null;
  const principal = await getCurrentPrincipal(request);
  return {
    ok: true,
    code,
    doco: { id: doco.id, handle: doco.handle },
    inviter: inviter ? { username: inviter.github_login ?? inviter.id } : null,
    expires_at: invite.expires_at,
    signedIn: principal ? { id: principal.id, username: principal.username } : null,
  } satisfies LoaderOk;
}

type ActionResult =
  | { error: string }
  | {
      ok: true;
      doco_url: string;
      doco_handle: string;
    };

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { code: string };
}): Promise<ActionResult | Response> {
  const principal = await getCurrentPrincipal(request);
  if (!principal) {
    const ret = `/invite/${encodeURIComponent(params.code)}`;
    return redirect(`/auth/github?return=${encodeURIComponent(ret)}`);
  }

  const code = (params.code ?? "").trim();
  if (!code) return { error: "Missing invite code." };

  const store = InviteStore.forDoco(rootDir());
  const invite = await store.findInvite(code);
  if (!invite) return { error: "Invite not found." };
  if (invite.status === "expired") return { error: "This invite has expired." };
  if (invite.status === "consumed") return { error: "This invite was already redeemed." };
  if (invite.status === "revoked") return { error: "This invite has been revoked." };

  const doco = await getDocoById(invite.doco_id);
  if (!doco) return { error: "The Doco this invite points at no longer exists." };

  const consumed = await store.consumeInvite(code, principal.id as EntityId<"principal">);
  if (!consumed) {
    return {
      error:
        "This invite was claimed by someone else in the same moment. Ask the minter for a fresh one.",
    };
  }

  // Bind the human Principal into the role grant on the level the
  // invite targets. Pre-cutover invites (no role/level) default to
  // doco-level `owner` to preserve prior behavior.
  const grantedRole: DocoRole = (consumed.role as DocoRole | undefined) ?? "owner";
  const inviteLevel = consumed.level ?? "doco";
  if (inviteLevel === "org" && consumed.org_id) {
    await upsertOrgUser({
      org_id: consumed.org_id,
      collaborator_id: principal.id,
      role: grantedRole,
    });
  } else {
    await upsertDocoUser({
      doco_id: invite.doco_id,
      collaborator_id: principal.id,
      role: grantedRole,
    });
  }

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const handle = doco.handle;
  return {
    ok: true,
    doco_url: `${origin}/${handle}/`,
    doco_handle: handle,
  };
}

export function meta() {
  return [{ title: "Join a Doco · Doco" }];
}

export default function InviteLanding({
  loaderData,
  actionData,
}: {
  loaderData: LoaderOk | LoaderError;
  actionData?: ActionResult;
}) {
  if (actionData && "ok" in actionData) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>You're in</CardTitle>
          </CardHeader>
          <CardContent>
            <Link
              to={`/${actionData.doco_handle}`}
              className="neo-raised-primary inline-flex items-center rounded-md px-4 py-2 text-sm font-semibold"
            >
              Continue
            </Link>
          </CardContent>
        </Card>
      </Shell>
    );
  }

  if ("error" in loaderData) {
    return (
      <Shell>
        <Card>
          <CardHeader>
            <CardTitle>{errorTitle(loaderData.error)}</CardTitle>
            <CardDescription>{errorDescription(loaderData.error)}</CardDescription>
          </CardHeader>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>
            You've been invited to doco <em>{loaderData.doco.handle}</em>
            {loaderData.inviter ? (
              <>
                {" "}
                by <em>{loaderData.inviter.username}</em>
              </>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>Doco keeps people, agents, and work aligned.</p>
          <p>
            Invite expires <strong>{new Date(loaderData.expires_at).toLocaleString()}</strong>.
            Single-use — once you accept, this URL stops working.
          </p>
          {loaderData.signedIn ? (
            <>
              <p>
                You're signed in as <strong>{loaderData.signedIn.username}</strong>.
              </p>
              {actionData && "error" in actionData ? (
                <p className="text-destructive">{actionData.error}</p>
              ) : null}
              <Form method="post" className="flex gap-2">
                <button
                  type="submit"
                  className="neo-raised-primary rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Accept invite
                </button>
                <Link
                  to="/"
                  className="neo-raised-sm rounded-md px-4 py-2 text-sm font-semibold"
                >
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
                  className="neo-raised rounded-md bg-card p-3 hover:border-primary"
                >
                  <span className="block text-sm font-semibold text-foreground">Human</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Sign in first, then accept the invite here.
                  </span>
                </Link>
                <Link
                  to={`/invite/${loaderData.code}/agent.txt`}
                  reloadDocument
                  className="neo-raised rounded-md bg-card p-3 hover:border-primary"
                >
                  <span className="block text-sm font-semibold text-foreground">Agent</span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    Open the plain-text redeem instructions.
                  </span>
                </Link>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </Shell>
  );
}

function errorTitle(err: LoaderError["error"]): string {
  if (err === "missing_code") return "No invite code in the URL";
  if (err === "not_found") return "Invite not found";
  if (err === "expired") return "Invite expired";
  if (err === "consumed") return "Invite already redeemed";
  if (err === "revoked") return "Invite revoked";
  return "The Doco this invite pointed at no longer exists";
}

function errorDescription(err: LoaderError["error"]): string {
  if (err === "missing_code") return "Open the URL the inviter shared, not /invite/ on its own.";
  if (err === "not_found") return "This invite link doesn't match any active or past invite.";
  if (err === "expired") return "Ask the inviter for a fresh URL.";
  if (err === "consumed")
    return "This invite was used. Each invite URL is single-use; ask for a new one.";
  if (err === "revoked") return "The minter revoked this invite. Ask them for a fresh one.";
  return "The Doco it pointed at has been deleted.";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header>
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <VersionPill />
        </div>
      </header>
      <main className="mx-auto max-w-xl px-6 py-12 w-full space-y-4">
        <Breadcrumb items={[{ label: "Home", to: "/" }, { label: "Invite" }]} />
        {children}
      </main>
    </div>
  );
}
