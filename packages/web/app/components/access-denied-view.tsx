import { Link } from "react-router";

import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";

export type AccessDeniedData = {
  kind: "access_denied";
  doco_handle: string;
  owner_slug: string;
  signed_in: boolean;
};

export function isAccessDeniedData(value: unknown): value is AccessDeniedData {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.kind === "access_denied" &&
    typeof v.doco_handle === "string" &&
    typeof v.owner_slug === "string" &&
    typeof v.signed_in === "boolean"
  );
}

export function AccessDeniedView({
  data,
  currentPath,
}: {
  data: AccessDeniedData;
  currentPath: string;
}) {
  const { doco_handle, signed_in } = data;
  return (
    <div>
      <header className="bg-background">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <VersionPill />
        </div>
      </header>
      <main className="mx-auto max-w-md px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Private doco</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              <span className="font-mono">{doco_handle}</span> is private.
            </p>
            {signed_in ? (
              <form method="post" action="/access-requests" className="mt-3">
                <input type="hidden" name="intent" value="request" />
                <input type="hidden" name="doco" value={doco_handle} />
                <p className="text-sm">You don't have access — request it from an owner:</p>
                <label className="mt-2 block text-xs text-muted-foreground">
                  Role
                  <select
                    name="role"
                    defaultValue="reader"
                    className="mt-1 block rounded-md px-2 py-1 text-sm"
                  >
                    <option value="reader">Reader — read</option>
                    <option value="writer">Writer — read + write</option>
                  </select>
                </label>
                <button
                  type="submit"
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 mt-3 inline-flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Request access
                </button>
                <p className="mt-2 text-xs text-muted-foreground">
                  An owner approves it in their access-requests inbox; you'll get in without
                  reconnecting.
                </p>
              </form>
            ) : (
              <>
                <p className="mt-3 text-sm">Sign in to continue.</p>
                <Link
                  to={`/sign-in?next=${encodeURIComponent(currentPath)}`}
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold"
                >
                  Sign in
                </Link>
                <p className="mt-4 text-xs text-muted-foreground">
                  If your account doesn't have access, ask a doco owner to invite you.
                </p>
              </>
            )}
            <div className="mt-6 border-t border-border pt-4">
              <p className="text-xs font-semibold text-muted-foreground">Are you an AI agent?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Get access without waiting for a human invite — pick the path for your client:
              </p>
              <p className="mt-3 text-xs font-semibold text-muted-foreground">
                Connector clients (claude.ai, ChatGPT, Cursor, Claude Desktop)
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Add Doco as a custom connector pointing at{" "}
                <code className="rounded bg-input px-1 py-0.5 font-mono">https://doco.to/mcp</code>,
                approve the OAuth prompt, and grant this doco on the approval screen. Then retry —
                your client carries the token from then on.
              </p>
              <p className="mt-3 text-xs font-semibold text-muted-foreground">
                CLI / repo agents (Claude Code, Codex)
              </p>
              <ol className="mt-1 list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                <li>
                  Call the{" "}
                  <code className="rounded bg-input px-1 py-0.5 font-mono">doco_authenticate</code>{" "}
                  MCP tool, or POST{" "}
                  <code className="rounded bg-input px-1 py-0.5 font-mono">
                    /oauth/device_authorization
                  </code>
                  . Full recipe:{" "}
                  <Link to="/protocol/agent-oauth-recipe" className="underline hover:opacity-80">
                    /protocol/agent-oauth-recipe
                  </Link>
                  .
                </li>
                <li>
                  Show your human the verification link. They approve with one click at{" "}
                  <Link to="/device" className="underline hover:opacity-80">
                    /device
                  </Link>
                  .
                </li>
                <li>Retry your request — you're in.</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
