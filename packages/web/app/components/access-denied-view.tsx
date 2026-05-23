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
          <Link
            to="/"
            className="inline-flex items-center hover:opacity-80"
            aria-label="Doco home"
          >
            <DocoMark height={28} />
          </Link>
          <VersionPill />
        </div>
      </header>
      <main className="mx-auto max-w-md px-6 py-10">
        <Card>
          <CardHeader>
            <CardTitle>Private Doco</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              <span className="font-mono">{doco_handle}</span> is private.
            </p>
            {signed_in ? (
              <p className="mt-3 text-sm">
                You don't have access. Ask the Doco's owner for an invite URL —
                they can mint one from the invite manager.
              </p>
            ) : (
              <>
                <p className="mt-3 text-sm">Sign in to continue.</p>
                <Link
                  to={`/sign-in?next=${encodeURIComponent(currentPath)}`}
                  className="neo-raised-primary mt-4 inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-semibold"
                >
                  Sign in
                </Link>
                <p className="mt-4 text-xs text-muted-foreground">
                  If your account doesn't have access, ask the Doco's owner for
                  an invite URL.
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
