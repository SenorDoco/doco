// /<doco-handle>/members — doco-level members management
// (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62). Owner-only. Lists
// every principal with an explicit doco_members row, plus the doco's
// direct owner (inherited owner role, not editable here), and lets
// the owner add/change/remove role grants.

import {
  type DocoRole,
  getDocoById,
  getPrincipalById,
  getPrincipalByUsername,
  listDocoMembers,
  removeDocoMember,
  upsertDocoMember,
} from "@doco/db";
import { Form, Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { loadDocoForAdmin, normalizeDocoParams } from "~/lib/doco-access.server";

const ALL_ROLES: DocoRole[] = ["owner", "approver", "author", "reader"];

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { ownerSlug, docoSlug, handle } = await normalizeDocoParams(params);
  const { meta, me } = await loadDocoForAdmin(request, handle);
  const doco = await getDocoById(meta.docoId);
  if (!doco) throw new Response("Doco not found", { status: 404 });

  const members = await listDocoMembers(meta.docoId);
  const enriched = await Promise.all(
    members.map(async (m) => {
      const p = await getPrincipalById(m.principal_id);
      return {
        principal_id: m.principal_id,
        username: p?.username ?? m.principal_id,
        display_name: p?.display_name ?? null,
        role: m.role,
        joined_at: m.joined_at,
      };
    }),
  );

  return {
    ownerSlug,
    docoSlug,
    handle,
    docoId: meta.docoId,
    me,
    members: enriched,
    docoOwnerId: doco.owner_id,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const { handle } = await normalizeDocoParams(params);
  const { meta } = await loadDocoForAdmin(request, handle);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "add") {
    const username = String(form.get("username") ?? "")
      .trim()
      .toLowerCase();
    const role = String(form.get("role") ?? "author") as DocoRole;
    if (!username) return { error: "Username is required." };
    if (!ALL_ROLES.includes(role))
      return { error: "Role must be owner, approver, author, or reader." };
    const p = await getPrincipalByUsername(username);
    if (!p) return { error: `No principal with username "${username}".` };
    await upsertDocoMember({ doco_id: meta.docoId, principal_id: p.id, role });
    return { ok: true as const };
  }

  if (intent === "update") {
    const principalId = String(form.get("principal_id") ?? "").trim();
    const role = String(form.get("role") ?? "") as DocoRole;
    if (!principalId) return { error: "principal_id missing." };
    if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
    await upsertDocoMember({ doco_id: meta.docoId, principal_id: principalId, role });
    return { ok: true as const };
  }

  if (intent === "remove") {
    const principalId = String(form.get("principal_id") ?? "").trim();
    if (!principalId) return { error: "principal_id missing." };
    await removeDocoMember(meta.docoId, principalId);
    return { ok: true as const };
  }

  return { error: `Unknown intent: ${intent}` };
}

export function meta() {
  return [{ title: "Members · Doco" }];
}

export default function DocoMembersPage({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: { error?: string; ok?: true };
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={loaderData.me} docoScope={{ handle: loaderData.handle }} />
      <main className="mx-auto w-full max-w-3xl px-6 py-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Members</h1>
            <p className="text-sm text-muted-foreground">
              Manage who has access to{" "}
              <Link to={`/${loaderData.handle}`} className="underline">
                {loaderData.handle}
              </Link>{" "}
              and at what role.
            </p>
          </div>
          <Link
            to={`/${loaderData.handle}/settings`}
            className="text-sm underline text-muted-foreground"
          >
            Back to settings
          </Link>
        </header>

        {actionData?.error ? (
          <Card>
            <CardContent className="pt-4">
              <p className="text-sm text-destructive">{actionData.error}</p>
            </CardContent>
          </Card>
        ) : null}

        <Card>
          <CardHeader>
            <CardTitle>Doco members</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {loaderData.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No explicit members yet. The doco owner is <code>{loaderData.docoOwnerId}</code>.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-medium">User</th>
                    <th className="pb-2 font-medium">Role</th>
                    <th className="pb-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {loaderData.members.map((m) => (
                    <tr key={m.principal_id} data-testid={`member-row-${m.username}`}>
                      <td className="py-2 align-middle">
                        <div className="font-medium">{m.username}</div>
                        {m.display_name ? (
                          <div className="text-xs text-muted-foreground">{m.display_name}</div>
                        ) : null}
                      </td>
                      <td className="py-2 align-middle">
                        <Form method="post" className="inline-flex items-center gap-2">
                          <input type="hidden" name="intent" value="update" />
                          <input type="hidden" name="principal_id" value={m.principal_id} />
                          <select
                            name="role"
                            defaultValue={m.role}
                            className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                            data-testid={`role-select-${m.username}`}
                          >
                            {ALL_ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                          <button
                            type="submit"
                            className="rounded-md border border-border px-2 py-1 text-xs hover:bg-card"
                            data-testid={`save-role-${m.username}`}
                          >
                            Save
                          </button>
                        </Form>
                      </td>
                      <td className="py-2 align-middle text-right">
                        <Form method="post" className="inline">
                          <input type="hidden" name="intent" value="remove" />
                          <input type="hidden" name="principal_id" value={m.principal_id} />
                          <button
                            type="submit"
                            className="rounded-md border border-border px-2 py-1 text-xs text-destructive hover:bg-card"
                            data-testid={`remove-member-${m.username}`}
                          >
                            Remove
                          </button>
                        </Form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Add a member</CardTitle>
          </CardHeader>
          <CardContent>
            <Form method="post" className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <input type="hidden" name="intent" value="add" />
              <label className="flex flex-1 flex-col gap-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  Username
                </span>
                <input
                  name="username"
                  type="text"
                  required
                  data-testid="add-member-username"
                  className="rounded-md border border-border bg-background px-3 py-2"
                  placeholder="alex"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Role</span>
                <select
                  name="role"
                  defaultValue="author"
                  data-testid="add-member-role"
                  className="rounded-md border border-border bg-background px-3 py-2"
                >
                  {ALL_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                data-testid="add-member-submit"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Add member
              </button>
            </Form>
            <p className="mt-3 text-xs text-muted-foreground">
              Effective role on each scope is <code>max(org role, doco role, scope role)</code>. To
              grant a role on a specific scope, open that scope's page and use the Members panel
              there.
            </p>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
