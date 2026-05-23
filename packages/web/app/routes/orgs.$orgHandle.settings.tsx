import { getOrgRole, withClient } from "@doco/db";
import { validateRequestedDocoHandle as validateRequestedOrgHandle } from "@doco/shared";
import { Form, Link, redirect, useSearchParams } from "react-router";
import { Breadcrumb, orgBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import {
  HANDLE_FORMAT_HELP,
  HANDLE_INPUT_PATTERN,
  friendlyHandleValidationError,
  handleValidityMessage,
} from "~/lib/handle-format";
import { getCurrentPrincipal } from "~/lib/session.server";

interface OrgSettingsRow {
  id: string;
  handle: string;
  docoCount: number;
}

async function loadOrgSettingsRow(orgHandle: string): Promise<OrgSettingsRow | null> {
  return withClient(async (c) => {
    const { rows } = await c.query<{
      id: string;
      handle: string;
      doco_count: string;
    }>(
      `SELECT id, handle,
              (
                SELECT COUNT(*)::text FROM docos d
                 WHERE d.org_id = organizations.id
              ) AS doco_count
         FROM organizations
        WHERE handle = $1
        LIMIT 1`,
      [orgHandle],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: String(row.id),
      handle: String(row.handle),
      docoCount: Number(row.doco_count),
    };
  });
}

async function requireOrgOwner(request: Request, orgHandle: string) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect(`/sign-in?next=${encodeURIComponent(new URL(request.url).pathname)}`);
  const org = await loadOrgSettingsRow(orgHandle);
  if (!org) throw new Response(`Org "${orgHandle}" not found.`, { status: 404 });
  const role = await getOrgRole(org.id, me.id);
  if (role !== "owner") {
    throw new Response("Only organization owners can manage settings.", { status: 403 });
  }
  return { me, org };
}

async function renameOrganizationHandle(opts: {
  orgId: string;
  currentHandle: string;
  nextHandle: string;
}): Promise<void> {
  const handleError = validateRequestedOrgHandle(opts.nextHandle);
  if (handleError) throw new Error(handleError);
  if (opts.currentHandle === opts.nextHandle) return;

  await withClient(async (c) => {
    const duplicate = await c.query(
      `SELECT 1 FROM organizations
        WHERE handle = $1 AND id <> $2
        LIMIT 1`,
      [opts.nextHandle, opts.orgId],
    );
    if ((duplicate.rowCount ?? 0) > 0) {
      throw new Error(`Organization handle "${opts.nextHandle}" is already taken.`);
    }

    const current = await c.query<{ data: Record<string, unknown> | null }>(
      "SELECT data FROM organizations WHERE id = $1 LIMIT 1",
      [opts.orgId],
    );
    const existing = current.rows[0]?.data;
    if (!existing) throw new Error(`Organization "${opts.currentHandle}" not found.`);
    const yaml: Record<string, unknown> = { ...existing };
    yaml.handle = opts.nextHandle;

    await c.query(
      `UPDATE organizations
          SET handle = $2,
              name = $2,
              data = $3::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [opts.orgId, opts.nextHandle, JSON.stringify(yaml)],
    );
  });
}

async function deleteOrganizationAndDocos(orgId: string): Promise<void> {
  await withClient(async (c) => {
    await c.query("BEGIN");
    try {
      await c.query("DELETE FROM docos WHERE org_id = $1", [orgId]);
      await c.query("DELETE FROM organizations WHERE id = $1", [orgId]);
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    }
  });
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { orgHandle: string };
}) {
  return requireOrgOwner(request, params.orgHandle);
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { orgHandle: string };
}) {
  const { org } = await requireOrgOwner(request, params.orgHandle);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "rename");

  if (intent === "delete") {
    const confirmHandle = String(form.get("confirm_handle") ?? "").trim();
    if (confirmHandle !== org.handle) {
      return { error: `To confirm, type the organization handle exactly: "${org.handle}".` };
    }
    await deleteOrganizationAndDocos(org.id);
    return redirect(`/orgs?deleted=${encodeURIComponent(org.handle)}`);
  }

  if (intent !== "rename") return { error: `Unknown intent: ${intent}` };

  const nextHandle = String(form.get("org_handle") ?? "")
    .trim()
    .toLowerCase();
  if (!nextHandle) return { error: "Organization handle is required." };

  try {
    await renameOrganizationHandle({
      orgId: org.id,
      currentHandle: org.handle,
      nextHandle,
    });
  } catch (error) {
    return {
      error: friendlyHandleValidationError((error as Error).message, "Organization handle"),
    };
  }

  return redirect(`/orgs/${nextHandle}/settings`);
}

export function meta({ params }: { params: { orgHandle: string } }) {
  return [{ title: `Settings · ${params.orgHandle} · Doco` }];
}

export default function OrgSettings({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string } | undefined;
}) {
  const { me, org } = loaderData;
  const [searchParams] = useSearchParams();
  const isConfirmingDelete = searchParams.get("confirm") === "delete";

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-6 space-y-4">
        <Breadcrumb items={orgBreadcrumb({ orgSlug: org.handle, pageLabel: "Settings" })} />
        {actionData?.error ? (
          <div className="rounded-md border border-destructive bg-destructive/5 px-4 py-3 text-xs text-destructive">
            {actionData.error}
          </div>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Rename</CardTitle>
            <CardDescription>Update the organization handle used in URLs.</CardDescription>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-3">
              <input type="hidden" name="intent" value="rename" />
              <label className="block text-xs">
                <span className="mb-1 block font-semibold text-foreground">
                  Organization handle
                </span>
                <input
                  name="org_handle"
                  required
                  pattern={HANDLE_INPUT_PATTERN}
                  defaultValue={org.handle}
                  title={HANDLE_FORMAT_HELP}
                  aria-describedby="org-handle-help"
                  onInvalid={(event) => {
                    event.currentTarget.setCustomValidity(
                      handleValidityMessage(event.currentTarget.validity, "Organization handle"),
                    );
                  }}
                  onInput={(event) => event.currentTarget.setCustomValidity("")}
                  className="w-full rounded-md px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-primary"
                />
                <span id="org-handle-help" className="mt-1 block text-[11px] text-muted-foreground">
                  {HANDLE_FORMAT_HELP} Renaming takes effect immediately.
                </span>
              </label>
              <button
                type="submit"
                className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
              >
                Rename organization
              </button>
            </Form>
          </CardContent>
        </Card>

        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-base text-destructive">Danger zone</CardTitle>
            <CardDescription>
              Deleting this organization permanently removes it and its {org.docoCount} doco
              {org.docoCount === 1 ? "" : "s"}. This cannot be undone.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {!isConfirmingDelete ? (
              <Link
                to={`/orgs/${org.handle}/settings?confirm=delete`}
                className="inline-block rounded-md border border-destructive px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/10"
              >
                Delete this organization...
              </Link>
            ) : (
              <Form method="post" className="space-y-3">
                <input type="hidden" name="intent" value="delete" />
                <p className="text-xs">
                  Type the organization handle{" "}
                  <span className="font-mono font-semibold">{org.handle}</span> to confirm.
                </p>
                <input
                  name="confirm_handle"
                  required
                  autoComplete="off"
                  placeholder={org.handle}
                  className="w-full rounded-md px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-destructive"
                />
                <div className="flex items-center gap-2">
                  <button
                    type="submit"
                    className="rounded-md bg-destructive px-4 py-2 text-xs font-semibold text-destructive-foreground hover:opacity-90"
                  >
                    Delete permanently
                  </button>
                  <Link
                    to={`/orgs/${org.handle}/settings`}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Cancel
                  </Link>
                </div>
              </Form>
            )}
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
