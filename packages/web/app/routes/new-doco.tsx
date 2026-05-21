import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { loadHostConfig } from "~/lib/host";
import { listMyOrgs, lookupOrgHandle } from "~/lib/org-helpers.server";
import {
  addOrganizationByHandle,
  createDocoInOrg,
  ensurePersonalOrganization,
  findAvailableDocoHandle,
} from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session";

/**
 * /new-doco — create a Doco (v15 model).
 *
 * Form fields:
 *   - `org_id`: ULID of the chosen org, or empty when creating a new one inline.
 *   - `new_org_handle`: optional new-org handle (used when org_id is empty).
 *   - `suffix`: the suffix after `<org-handle>-` (e.g. `bpms` → `acme-bpms`).
 *   - `template_handle`: one of "generic" | "user-flows" | "state-machines" |
 *     "business-processes" — the template tile picker.
 *   - `visibility`: "private" | "public".
 *   - `accept_suggested_handle`: "1" to silently accept a server-suggested
 *     collision-free handle.
 *
 * Route imports go through `~/lib/redeem.server` and
 * `~/lib/org-helpers.server` (both `.server.ts`) so react-router strips
 * the @doco/host + @doco/db chain from the CLIENT bundle.
 */

const TEMPLATES = [
  {
    handle: "generic",
    label: "Generic (empty)",
    description: "Start with a blank doco. No rules, no node-type restrictions.",
  },
  {
    handle: "user-flows",
    label: "User Flows",
    description: "Document end-to-end user journeys as steps, branches, and decisions.",
  },
  {
    handle: "state-machines",
    label: "State Machines",
    description: "Formal state-machine modeling — states, transitions, invariants.",
  },
  {
    handle: "business-processes",
    label: "Business Processes",
    description:
      "Document repeatable business processes — actors, gateways, milestones, outcomes. BPMN-inspired.",
  },
] as const;

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");
  // Backfill personal org for sign-ins that pre-date v15.
  await ensurePersonalOrganization(me.id, me.username);
  const orgs = await listMyOrgs(me.id);
  return { me, orgs, host: await loadHostConfig() };
}

export async function action({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");
  const form = await request.formData();
  const orgId = String(form.get("org_id") ?? "").trim();
  const newOrgHandleRaw = String(form.get("new_org_handle") ?? "")
    .trim()
    .toLowerCase();
  const suffix = String(form.get("suffix") ?? "")
    .trim()
    .toLowerCase();
  const templateHandle = String(form.get("template_handle") ?? "generic").trim();
  const visibility = String(form.get("visibility") ?? "private") as "private" | "public";
  const accept = form.get("accept_suggested_handle") === "1";

  // Step 1 — resolve the org (existing or freshly created).
  let chosenOrgId: string;
  let chosenOrgHandle: string;
  try {
    if (!orgId) {
      if (!newOrgHandleRaw) {
        return {
          error: "Pick an organization or type a new org handle.",
          suggestedHandle: null,
          suggestedOrgHandle: null,
          form: { orgId, newOrgHandle: newOrgHandleRaw, suffix, templateHandle, visibility },
        };
      }
      // Inline-create path always auto-suffixes (no separate
      // suggestion round-trip — the user is here to create, not to
      // bikeshed the org handle).
      const created = await addOrganizationByHandle({
        handle: newOrgHandleRaw,
        ownerPrincipalId: me.id,
        autoSuffix: true,
      });
      chosenOrgId = created.id;
      chosenOrgHandle = created.handle;
    } else {
      const handle = await lookupOrgHandle(orgId);
      if (!handle) {
        return {
          error: `Organization not found.`,
          suggestedHandle: null,
          suggestedOrgHandle: null,
          form: { orgId, newOrgHandle: newOrgHandleRaw, suffix, templateHandle, visibility },
        };
      }
      chosenOrgId = orgId;
      chosenOrgHandle = handle;
    }
  } catch (e) {
    return {
      error: (e as Error).message,
      suggestedHandle: null,
      suggestedOrgHandle: null,
      form: { orgId, newOrgHandle: newOrgHandleRaw, suffix, templateHandle, visibility },
    };
  }

  // Step 2 — validate suffix.
  if (!suffix) {
    return {
      error: "Doco suffix is required.",
      suggestedHandle: null,
      suggestedOrgHandle: chosenOrgHandle,
      form: { orgId: chosenOrgId, newOrgHandle: "", suffix, templateHandle, visibility },
    };
  }

  // Step 3 — create. Collision: web flow surfaces a suggestion + an
  // "Use suggestion" button that resubmits with autoSuffix=true.
  try {
    const rec = await createDocoInOrg({
      orgId: chosenOrgId,
      requestedSuffix: suffix,
      createdByPrincipalId: me.id,
      visibility,
      templateHandle: templateHandle === "generic" ? null : templateHandle,
      autoSuffix: accept,
    });
    throw redirect(`/${rec.handle}`);
  } catch (e) {
    if (e instanceof Response) throw e;
    const message = (e as Error).message;
    if (!accept && message.includes("already taken")) {
      const suggestion = await findAvailableDocoHandle(chosenOrgHandle, suffix);
      return {
        error: `Handle "${chosenOrgHandle}-${suffix}" is already taken. Suggested: "${suggestion}".`,
        suggestedHandle: suggestion,
        suggestedOrgHandle: chosenOrgHandle,
        form: { orgId: chosenOrgId, newOrgHandle: "", suffix, templateHandle, visibility },
      };
    }
    return {
      error: message,
      suggestedHandle: null,
      suggestedOrgHandle: chosenOrgHandle,
      form: { orgId: chosenOrgId, newOrgHandle: "", suffix, templateHandle, visibility },
    };
  }
}

export function meta() {
  return [{ title: "New doco · Doco" }];
}

export default function NewDoco({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?:
    | {
        error?: string;
        suggestedHandle?: string | null;
        suggestedOrgHandle?: string | null;
        form?: {
          orgId: string;
          newOrgHandle: string;
          suffix: string;
          templateHandle: string;
          visibility: string;
        };
      }
    | undefined;
}) {
  const { me, orgs } = loaderData;
  const f = actionData?.form;
  const initialOrgId = f?.orgId ?? orgs[0]?.id ?? "";
  const [orgId, setOrgId] = useState(initialOrgId);
  const [newOrgHandle, setNewOrgHandle] = useState(f?.newOrgHandle ?? "");
  const [suffix, setSuffix] = useState(f?.suffix ?? "");
  const isCreateNewOrg = orgId === "";
  const orgHandleDisplay = isCreateNewOrg
    ? newOrgHandle || "<org>"
    : (orgs.find((o) => o.id === orgId)?.handle ?? actionData?.suggestedOrgHandle ?? "<org>");
  const selectedTemplate = f?.templateHandle ?? "generic";

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8">
        <Card>
          <CardHeader>
            <CardTitle>New doco</CardTitle>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-4">
              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  1 · Organization
                </legend>
                <select
                  name="org_id"
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                  className="rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  {orgs.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.handle}
                      {o.handle === me.username ? " (personal)" : ""}
                    </option>
                  ))}
                  <option value="">+ Create a new organization</option>
                </select>
                {isCreateNewOrg ? (
                  <input
                    type="text"
                    name="new_org_handle"
                    pattern="[a-z0-9][a-z0-9_-]*"
                    value={newOrgHandle}
                    onChange={(e) => setNewOrgHandle(e.target.value.toLowerCase())}
                    placeholder="Organization handle"
                    className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                  />
                ) : null}
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  2 · Doco handle
                </legend>
                <input
                  type="text"
                  name="suffix"
                  required
                  pattern="[a-z0-9][a-z0-9_-]*"
                  value={suffix}
                  onChange={(e) => setSuffix(e.target.value.toLowerCase())}
                  placeholder="bpms"
                  className="w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Final handle:{" "}
                  <code data-testid="handle-preview">
                    {orgHandleDisplay}-{suffix || "<suffix>"}
                  </code>
                </span>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  3 · Template
                </legend>
                <div className="grid grid-cols-2 gap-2">
                  {TEMPLATES.map((t) => (
                    <label
                      key={t.handle}
                      className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 hover:bg-muted"
                    >
                      <input
                        type="radio"
                        name="template_handle"
                        value={t.handle}
                        defaultChecked={selectedTemplate === t.handle}
                        className="mt-0.5"
                      />
                      <span className="block">
                        <span className="block text-sm font-semibold">{t.label}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {t.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  4 · Visibility
                </legend>
                <select
                  name="visibility"
                  defaultValue={f?.visibility ?? "private"}
                  className="rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
              </fieldset>

              {actionData?.error ? (
                <p className="text-xs text-destructive">{actionData.error}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground hover:opacity-90"
                >
                  Create doco
                </button>
                {actionData?.suggestedHandle ? (
                  <button
                    type="submit"
                    name="accept_suggested_handle"
                    value="1"
                    className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
                  >
                    Use "{actionData.suggestedHandle}" instead
                  </button>
                ) : null}
                <Link
                  to="/dashboard"
                  className="text-xs text-muted-foreground hover:text-foreground"
                >
                  Cancel
                </Link>
              </div>
            </Form>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
    </div>
  );
}
