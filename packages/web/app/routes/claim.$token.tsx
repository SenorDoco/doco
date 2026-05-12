// /claim/<token> — human visits, signs in (or signs up), takes ownership of an
// unclaimed Doco created via the onboarding wizard. Per ADR-073.
//
// Atomic transfer:
//   1. Doco.owner_id = signed-in human
//   2. Bootstrap-owned agent.owner_id = signed-in human (the agent now belongs
//      to the claiming human)
//   3. Claim token marked used
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { rootDir } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { TokenStore } from "~/lib/tokens.server";
import { DocoMark } from "~/components/doco-mark";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

export async function loader({ request, params }: { request: Request; params: { token: string } }) {
  const root = rootDir();
  const me = getCurrentPrincipal(request);
  const store = TokenStore.forDoco(root);
  const claim = await store.resolveClaim(params.token);
  if (!claim) {
    return { status: "invalid" as const, host: loadHostConfig(), me };
  }
  // Read the Doco's slug for display. We have doco_id; walk docos/ tree to find it.
  const docoMeta = findDocoByIdInBootstrap(root, claim.doco_id);
  return {
    status: "open" as const,
    host: loadHostConfig(),
    me,
    docoSlug: docoMeta?.docoSlug ?? "(unknown)",
    expires_at: claim.expires_at,
  };
}

export async function action({ request, params }: { request: Request; params: { token: string } }) {
  const me = getCurrentPrincipal(request);
  if (!me) {
    return redirect(`/sign-in?next=${encodeURIComponent(`/claim/${params.token}`)}`);
  }
  const root = rootDir();
  const store = TokenStore.forDoco(root);
  const claim = await store.resolveClaim(params.token);
  if (!claim) return { error: "This claim link is invalid, used, or expired." };

  // 1. Find and rewrite the Doco's doco.yaml: owner_id → me.id; slug fields → me.username/<slug>.
  const docoRec = findDocoByIdInBootstrap(root, claim.doco_id);
  if (!docoRec) return { error: "The Doco this token refers to is no longer present." };
  try {
    rewriteDocoOwnership(docoRec.path, me.id, me.username, docoRec.docoSlug);
  } catch (e) {
    return { error: `Failed to update Doco ownership: ${(e as Error).message}` };
  }

  // 2. Rewrite the bootstrap-owned agent Principal: owner_id → me.id.
  try {
    rewritePrincipalOwner(root, claim.bootstrap_agent_id, me.id);
  } catch (e) {
    return { error: `Failed to transfer agent ownership: ${(e as Error).message}` };
  }

  // 3. Move the Doco directory: /docos/host-bootstrap/<slug>/ → /docos/<me.username>/<slug>/
  try {
    moveDocoDirectory(root, docoRec.docoSlug, me.username);
  } catch (e) {
    return { error: `Failed to move Doco directory: ${(e as Error).message}` };
  }

  // 4. Mark claim used.
  await store.markClaimUsed(params.token);

  return redirect(`/${me.username}/${docoRec.docoSlug}`);
}

export function meta() {
  return [{ title: "Claim Doco · Doco" }];
}

export default function Claim() {
  const data = useLoaderData<Awaited<ReturnType<typeof loader>>>();
  const actionData = useActionData<{ error?: string } | undefined>();

  if (data.status === "invalid") {
    return (
      <ClaimChrome host={data.host}>
        <Card>
          <CardHeader>
            <CardTitle>Claim link not valid</CardTitle>
            <CardDescription>
              This URL is unknown, already used, or expired. Ask the agent to issue a new one
              (a new Doco, with a fresh claim URL).
            </CardDescription>
          </CardHeader>
        </Card>
      </ClaimChrome>
    );
  }

  if (!data.me) {
    return (
      <ClaimChrome host={data.host}>
        <Card>
          <CardHeader>
            <CardTitle>Claim Doco · {data.docoSlug}</CardTitle>
            <CardDescription>
              Sign in (or create an account) to take ownership of this unclaimed Doco. Expires{" "}
              {data.expires_at}.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link
              to="/sign-in"
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
            >
              Sign in
            </Link>{" "}
            <Link
              to="/sign-up"
              className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input"
            >
              Sign up
            </Link>
          </CardContent>
        </Card>
      </ClaimChrome>
    );
  }

  return (
    <ClaimChrome host={data.host}>
      <Card>
        <CardHeader>
          <CardTitle>Claim Doco · {data.docoSlug}</CardTitle>
          <CardDescription>
            You're signed in as <code>{data.me.username}</code>. Confirming will make you the owner
            of this Doco and of the agent that's been working on it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Form method="post">
            <button
              type="submit"
              className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
            >
              Claim ownership
            </button>
          </Form>
          {actionData?.error ? (
            <p className="mt-2 text-xs text-destructive">{actionData.error}</p>
          ) : null}
        </CardContent>
      </Card>
    </ClaimChrome>
  );
}

function ClaimChrome({
  host,
  children,
}: {
  host: { name: string };
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <span className="text-xs text-muted-foreground">/ {host.name}</span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-6 py-12 space-y-4">{children}</main>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// helpers (server-side; sit in this file to keep the route self-contained)

function findDocoByIdInBootstrap(root: string, docoId: string): { path: string; docoSlug: string } | null {
  const dir = join(root, "docos", "host-bootstrap");
  if (!existsSync(dir)) return null;
  for (const slug of readdirSync(dir)) {
    const yamlPath = join(dir, slug, "doco.yaml");
    if (!existsSync(yamlPath)) continue;
    const e = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
    if (e.id === docoId) return { path: join(dir, slug), docoSlug: slug };
  }
  return null;
}

function rewriteDocoOwnership(
  docoPath: string,
  newOwnerId: string,
  newOwnerUsername: string,
  docoSlug: string,
): void {
  const yamlPath = join(docoPath, "doco.yaml");
  const e = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  e.owner_id = newOwnerId;
  e.owner_username = newOwnerUsername;
  e.slug = `${newOwnerUsername}/${docoSlug}`;
  writeFileSync(yamlPath, stringifyYaml(e), "utf8");
}

function moveDocoDirectory(root: string, docoSlug: string, newOwnerUsername: string): void {
  const oldPath = join(root, "docos", "host-bootstrap", docoSlug);
  const newOwnerDir = join(root, "docos", newOwnerUsername);
  const newPath = join(newOwnerDir, docoSlug);
  if (!existsSync(newOwnerDir)) mkdirSync(newOwnerDir, { recursive: true });
  if (existsSync(newPath)) throw new Error(`Slug collision: ${newOwnerUsername}/${docoSlug} already exists`);
  renameSync(oldPath, newPath);
}

function rewritePrincipalOwner(root: string, principalId: string, newOwnerId: string): void {
  const path = join(root, "principals", `${principalId}.yaml`);
  if (!existsSync(path)) throw new Error(`Principal ${principalId} not found`);
  const p = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  p.owner_id = newOwnerId;
  writeFileSync(path, stringifyYaml(p), "utf8");
}
