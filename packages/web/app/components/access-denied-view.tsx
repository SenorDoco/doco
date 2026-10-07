import { Link } from "react-router";

import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NarrowPageMain } from "~/components/page-main";

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
    <NarrowPageMain className="py-10">
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
        </CardContent>
      </Card>
    </NarrowPageMain>
  );
}
