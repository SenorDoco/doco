// /orgs/<slug>/members — organization-level member management
// (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62). Owner-only. Grants here flow
// down into every doco the org owns (highest-wins composition):
// effective doco role = max(org role, doco role, scope role).

import { Form, Link, redirect } from "react-router";
import {
  type DocoRole,
  getPrincipalById,
  getPrincipalByUsername,
  isOrgAdmin,
  resolveOwnerSlug,
  upsertOrgMember,
  withClient,
} from "@doco/db";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { getCurrentPrincipal } from "~/lib/session";

const ALL_ROLES: DocoRole[] = ["owner", "approver", "author", "reader"];

async function listOrgMembersWithPrincipals(orgId: string) {
  return withClient(async (c) => {
    const r = await c.query<{ principal_id: string; role: string; joined_at: string | Date }>(
      `SELECT principal_id, role, joined_at FROM org_members WHERE org_id = $1 ORDER BY joined_at`,
      [orgId],
    );
    return Promise.all(
      r.rows.map(async (row) => {
        const p = await getPrincipalById(row.principal_id);
        return {
          principal_id: row.principal_id,
          username: p?.username ?? row.principal_id,
          display_name: p?.display_name ?? null,
          role: row.role as DocoRole,
          joined_at: row.joined_at instanceof Date ? row.joined_at.toISOString() : String(row.joined_at),
        };
      }),
    );
  });
}

async function removeOrgMember(orgId: string, principalId: string) {
  await withClient(async (c) => {
    await c.query(
      `DELETE FROM org_members WHERE org_id = $1 AND principal_id = $2`,
      [orgId, principalId],
    );
  });
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { slug: string };
}) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    return redirect(`/sign-in?return=${encodeURIComponent(`/orgs/${params.slug}/members`)}`);
  }
  const resolved = await resolveOwnerSlug(params.slug);
  if (!resolved || resolved.kind !== "organization") {
    throw new Response("Organization not found", { status: 404 });
  }
  const isAdmin = await isOrgAdmin(resolved.org.id, me.id);
  if (!isAdmin) {
    throw new Response("Forbidden: only org owners can manage members.", { status: 403 });
  }
  const members = await listOrgMembersWithPrincipals(resolved.org.id);
  return {
    me,
    org: { id: resolved.org.id, slug: resolved.org.slug, name: resolved.org.name },
    members,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { slug: string };
}) {
  const me = await getCurrentPrincipal(request);
  if (!me) return { error: "Sign in to manage org members." };
  const resolved = await resolveOwnerSlug(params.slug);
  if (!resolved || resolved.kind !== "organization") {
    return { error: "Organization not found." };
  }
  const orgId = resolved.org.id;
  if (!(await isOrgAdmin(orgId, me.id))) {
    return { error: "Forbidden: only org owners can change members." };
  }

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "add") {
    const username = String(form.get("username") ?? "").trim().toLowerCase();
    const role = String(form.get("role") ?? "author") as DocoRole;
    if (!username) return { error: "Username is required." };
    if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
    const p = await getPrincipalByUsername(username);
    if (!p) return { error: `No principal with username "${username}".` };
    await upsertOrgMember({ org_id: orgId, principal_id: p.id, role });
    return { ok: true as const };
  }

  if (intent === "update") {
    const principalId = String(form.get("principal_id") ?? "").trim();
    const role = String(form.get("role") ?? "") as DocoRole;
    if (!principalId) return { error: "principal_id missing." };
    if (!ALL_ROLES.includes(role)) return { error: "Invalid role." };
    await upsertOrgMember({ org_id: orgId, principal_id: principalId, role });
    return { ok: true as const };
  }

  if (intent === "remove") {
    const principalId = String(form.get("principal_id") ?? "").trim();
    if (!principalId) return { error: "principal_id missing." };
    await removeOrgMember(orgId, principalId);
    return { ok: true as const };
  }

  return { error: `Unknown intent: ${intent}` };
}

export function meta() {
  return [{ title: "Org members · Doco" }];
}

interface OrgLoaderData {
  me: { id: string; username: string; display_name: string; type: "person" | "agent"; email?: string };
  org: { id: string; slug: string; name: string };
  members: {
    principal_id: string;
    username: string;
    display_name: string | null;
    role: DocoRole;
    joined_at: string;
  }[];
}

export default function OrgMembersPage({
  loaderData,
  actionData,
}: {
  loaderData: OrgLoaderData;
  actionData?: { error?: string; ok?: true };
}) {
  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={loaderData.me} />
      <main className="mx-auto w-full max-w-3xl px-6 py-8 space-y-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold">
              Members of <span className="font-mono">{loaderData.org.slug}</span>
            </h1>
            <p className="text-sm text-muted-foreground">
              Roles granted here cover every doco owned by{" "}
              <strong>{loaderData.org.name}</strong>. Effective doco role is{" "}
              <code>max(org role, doco role, scope role)</code>.
            </p>
          </div>
          <Link to="/dashboard" className="text-sm underline text-muted-foreground">
            Dashboard
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
            <CardTitle>Org members</CardTitle>
          </CardHeader>
          <CardContent>
            {loaderData.members.length === 0 ? (
              <p className="text-sm text-muted-foreground">No members yet.</p>
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
                    <tr key={m.principal_id} data-testid={`org-member-row-${m.username}`}>
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
                            data-testid={`org-role-select-${m.username}`}
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
            <CardTitle>Add an org member</CardTitle>
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
                  data-testid="add-org-member-username"
                  className="rounded-md border border-border bg-background px-3 py-2"
                  placeholder="alex"
                />
              </label>
              <label className="flex flex-col gap-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-muted-foreground">Role</span>
                <select
                  name="role"
                  defaultValue="author"
                  data-testid="add-org-member-role"
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
                data-testid="add-org-member-submit"
                className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
              >
                Add
              </button>
            </Form>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
