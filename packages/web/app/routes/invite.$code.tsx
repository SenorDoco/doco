// /invite/<code> — browser landing page for a Doco invite.
//
// The page loads the invite, shows the project owner what they're
// being invited to (Doco name + minter, if known), and asks them to
// click "Accept". On accept:
//
//   - If signed in: the invite is redeemed, the human Principal is
//     joined to the Doco as a member, and a personal SessionToken is
//     minted for them. They see the `DOCO_KEY=` line + the matching
//     `doco.md` snippet so they can wire the Doco into a repo if they
//     want one.
//   - If not signed in: bounce through GitHub OAuth and come back here.
//
// Agents calling the same path get a tiny JSON view (no auth) and are
// redirected to `/api/v1/invites/<code>/redeem.json` for the actual
// exchange — this route is human-facing.

import { Form, Link, redirect } from "react-router";
import type { EntityId } from "@doco/shared";
import { getDocoById } from "@doco/db";
import { TokenStore } from "~/lib/tokens.server";
import { rootDir } from "~/lib/db.server";
import { getCurrentPrincipal } from "~/lib/session";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

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
  doco: { id: string; owner_slug: string; doco_slug: string };
  expires_at: string;
  signedIn: { id: string; username: string; display_name: string } | null;
};

export async function loader({ request, params }: { request: Request; params: { code: string } }) {
  const code = (params.code ?? "").trim();
  if (!code) return { error: "missing_code" } satisfies LoaderError;

  const store = TokenStore.forDoco(rootDir());
  const invite = await store.findInvite(code);
  if (!invite) return { error: "not_found" } satisfies LoaderError;
  if (invite.status === "expired") return { error: "expired" } satisfies LoaderError;
  if (invite.status === "consumed") return { error: "consumed" } satisfies LoaderError;
  if (invite.status === "revoked") return { error: "revoked" } satisfies LoaderError;

  const doco = await getDocoById(invite.doco_id);
  if (!doco) return { error: "doco_not_found" } satisfies LoaderError;

  const principal = await getCurrentPrincipal(request);
  return {
    ok: true,
    code,
    doco: { id: doco.id, owner_slug: doco.owner_slug, doco_slug: doco.doco_slug },
    expires_at: invite.expires_at,
    signedIn: principal
      ? { id: principal.id, username: principal.username, display_name: principal.display_name }
      : null,
  } satisfies LoaderOk;
}

type ActionResult =
  | { error: string }
  | {
      ok: true;
      doco_url: string;
      doco_slug: string;
      doco_key: string;
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

  const store = TokenStore.forDoco(rootDir());
  const invite = await store.findInvite(code);
  if (!invite) return { error: "Invite not found." };
  if (invite.status === "expired") return { error: "This invite has expired." };
  if (invite.status === "consumed") return { error: "This invite was already redeemed." };
  if (invite.status === "revoked") return { error: "This invite has been revoked." };

  const doco = await getDocoById(invite.doco_id);
  if (!doco) return { error: "The Doco this invite points at no longer exists." };

  // Bind the existing human Principal to the Doco — no new Principal
  // minted. The SessionToken IS the human's personal DOCO_KEY for
  // this Doco.
  const session = await store.issueSessionToken(
    principal.id as EntityId<"principal">,
    invite.minted_by_principal_id ?? undefined,
    invite.doco_id,
  );
  const consumed = await store.consumeInvite(code, principal.id as EntityId<"principal">);
  if (!consumed) {
    await store.revoke(session.token, false);
    return { error: "This invite was claimed by someone else in the same moment. Ask the minter for a fresh one." };
  }

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  return {
    ok: true,
    doco_url: `${origin}/by-id/${doco.id}/`,
    doco_slug: `${doco.owner_slug}/${doco.doco_slug}`,
    doco_key: session.token,
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
            <CardDescription>
              You now have your own access key to{" "}
              <Link
                to={`/${actionData.doco_slug}`}
                className="text-primary hover:underline"
              >
                {actionData.doco_slug}
              </Link>
              . Browse it any time at the link above.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              To use this Doco from an agent in a repo, drop these two files at the repo root:
            </p>
            <div className="rounded-md border border-border bg-card p-3 font-mono text-xs">
              <div className="text-muted-foreground mb-1">.env (gitignored)</div>
              <div className="break-all">DOCO_KEY={actionData.doco_key}</div>
            </div>
            <div className="rounded-md border border-border bg-card p-3 font-mono text-xs">
              <div className="text-muted-foreground mb-1">doco.md (committed)</div>
              <div className="whitespace-pre-wrap break-all">
                {`# Doco\n\nThis project is tracked in Doco at:\n${actionData.doco_url}\n\nNeed access? Ask the project owner for an invite URL.`}
              </div>
            </div>
            <p className="text-xs">
              Then run any agent in that repo — it'll auto-load the protocol from{" "}
              <code>{actionData.doco_url}bootstrap.json</code>.
            </p>
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
          <CardContent className="text-sm text-muted-foreground">
            <Link to="/" className="text-primary hover:underline">
              Return to the host home
            </Link>
            .
          </CardContent>
        </Card>
      </Shell>
    );
  }

  return (
    <Shell>
      <Card>
        <CardHeader>
          <CardTitle>You've been invited to a Doco</CardTitle>
          <CardDescription>
            <strong>
              {loaderData.doco.owner_slug}/{loaderData.doco.doco_slug}
            </strong>{" "}
            is tracking decisions, intents, and rules in Doco. Click Accept to join.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <p>
            Invite expires <strong>{new Date(loaderData.expires_at).toLocaleString()}</strong>.
            Single-use — once you accept, this URL stops working.
          </p>
          {loaderData.signedIn ? (
            <p>
              Signed in as <strong>{loaderData.signedIn.username}</strong>.
            </p>
          ) : (
            <p>
              You'll be asked to sign in with GitHub before joining.
            </p>
          )}
          {actionData && "error" in actionData ? (
            <p className="text-sm text-destructive">{actionData.error}</p>
          ) : null}
          <Form method="post" className="flex gap-2">
            <button
              type="submit"
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Accept invite
            </button>
            <Link
              to="/"
              className="rounded-md border border-border px-4 py-2 text-sm font-semibold hover:bg-card"
            >
              Decline
            </Link>
          </Form>
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
  if (err === "not_found")
    return "This invite link doesn't match any active or past invite.";
  if (err === "expired") return "Ask the inviter for a fresh URL.";
  if (err === "consumed")
    return "This invite was used. Each invite URL is single-use; ask for a new one.";
  if (err === "revoked")
    return "The minter revoked this invite. Ask them for a fresh one.";
  return "The Doco it pointed at has been deleted.";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <VersionPill />
        </div>
      </header>
      <main className="mx-auto max-w-xl px-6 py-12 w-full">{children}</main>
    </div>
  );
}
