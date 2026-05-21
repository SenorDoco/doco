import { Form, Link, redirect } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { WizardStepper } from "~/components/wizard-stepper";
import { listMyOrgs, lookupOrgHandle } from "~/lib/org-helpers.server";
import {
  addOrganizationByHandle,
  createDocoInOrg,
  findAvailableDocoHandle,
} from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session";

/**
 * /new-doco/template — Step 3 of 4. The actionable terminal step:
 * captures template + visibility, then creates the org (if a new one
 * was named in Step 1) AND the doco, then redirects to /:handle/welcome
 * (Step 4).
 *
 * The org is created lazily here — not in Step 1 — so that backing out
 * of the wizard before this submit leaves no rows behind.
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
  {
    handle: "test",
    label: "Test",
    description:
      "Executable tests inspired by TDD and AI evals. Each Eval pins one checkable claim about a decision, article, or action.",
  },
] as const;

interface ParsedState {
  orgId: string;
  newOrgHandle: string;
  suffix: string;
  visibility: "private" | "public";
}

function parseState(params: URLSearchParams): ParsedState {
  return {
    orgId: (params.get("org_id") ?? "").trim(),
    newOrgHandle: (params.get("new_org_handle") ?? "").trim().toLowerCase(),
    suffix: (params.get("suffix") ?? "").trim().toLowerCase(),
    visibility: params.get("visibility") === "public" ? "public" : "private",
  };
}

function carryForwardUrl(path: string, state: ParsedState): string {
  const qs = new URLSearchParams({
    ...(state.orgId ? { org_id: state.orgId } : {}),
    ...(state.newOrgHandle ? { new_org_handle: state.newOrgHandle } : {}),
    suffix: state.suffix,
    visibility: state.visibility,
  });
  return `${path}?${qs.toString()}`;
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");

  const url = new URL(request.url);
  const state = parseState(url.searchParams);
  if ((!state.orgId && !state.newOrgHandle) || !state.suffix) {
    throw redirect("/new-doco");
  }
  const orgs = await listMyOrgs(me.id);
  const orgHandle = state.orgId
    ? (orgs.find((o) => o.id === state.orgId)?.handle ?? null)
    : state.newOrgHandle;
  return { me, ...state, orgHandle };
}

export async function action({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");

  const form = await request.formData();
  const state: ParsedState = {
    orgId: String(form.get("org_id") ?? "").trim(),
    newOrgHandle: String(form.get("new_org_handle") ?? "")
      .trim()
      .toLowerCase(),
    suffix: String(form.get("suffix") ?? "")
      .trim()
      .toLowerCase(),
    visibility: String(form.get("visibility") ?? "private") === "public" ? "public" : "private",
  };
  const templateHandle = String(form.get("template_handle") ?? "generic").trim();
  const visibility = state.visibility;
  const accept = form.get("accept_suggested_handle") === "1";

  if ((!state.orgId && !state.newOrgHandle) || !state.suffix) {
    throw redirect("/new-doco");
  }

  let chosenOrgId: string;
  let chosenOrgHandle: string;
  try {
    if (state.orgId) {
      const handle = await lookupOrgHandle(state.orgId);
      if (!handle) {
        return {
          error: "Organization not found.",
          suggestedHandle: null,
          state,
          form: { templateHandle, visibility },
        };
      }
      chosenOrgId = state.orgId;
      chosenOrgHandle = handle;
    } else {
      const created = await addOrganizationByHandle({
        handle: state.newOrgHandle,
        ownerPrincipalId: me.id,
        autoSuffix: true,
      });
      chosenOrgId = created.id;
      chosenOrgHandle = created.handle;
    }
  } catch (e) {
    return {
      error: (e as Error).message,
      suggestedHandle: null,
      state,
      form: { templateHandle, visibility },
    };
  }

  try {
    const rec = await createDocoInOrg({
      orgId: chosenOrgId,
      requestedSuffix: state.suffix,
      createdByPrincipalId: me.id,
      visibility,
      templateHandle: templateHandle === "generic" ? null : templateHandle,
      autoSuffix: accept,
    });
    throw redirect(`/${rec.handle}/welcome`);
  } catch (e) {
    if (e instanceof Response) throw e;
    const message = (e as Error).message;
    if (!accept && message.includes("already taken")) {
      const suggestion = await findAvailableDocoHandle(chosenOrgHandle, state.suffix);
      return {
        error: `Handle "${chosenOrgHandle}-${state.suffix}" is already taken. Suggested: "${suggestion}".`,
        suggestedHandle: suggestion,
        state,
        form: { templateHandle, visibility },
      };
    }
    return {
      error: message,
      suggestedHandle: null,
      state,
      form: { templateHandle, visibility },
    };
  }
}

export function meta() {
  return [{ title: "New doco · Step 3 of 4 · Doco" }];
}

export default function NewDocoStep3({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: {
    error?: string;
    suggestedHandle?: string | null;
    state?: ParsedState;
    form?: { templateHandle: string; visibility: string };
  };
}) {
  const { me, orgId, newOrgHandle, suffix, visibility, orgHandle } = loaderData;
  const state: ParsedState = { orgId, newOrgHandle, suffix, visibility };
  const finalHandle = `${orgHandle ?? "<org>"}-${suffix}`;
  const selectedTemplate = actionData?.form?.templateHandle ?? "generic";

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <WizardStepper current={3} />
        <Card>
          <CardHeader>
            <CardTitle>Template for {finalHandle}</CardTitle>
          </CardHeader>
          <CardContent>
            <Form method="post" className="space-y-4">
              {orgId ? <input type="hidden" name="org_id" value={orgId} /> : null}
              {newOrgHandle ? (
                <input type="hidden" name="new_org_handle" value={newOrgHandle} />
              ) : null}
              <input type="hidden" name="suffix" value={suffix} />
              <input type="hidden" name="visibility" value={visibility} />

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  4 · Template
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
                  to={carryForwardUrl("/new-doco/constitution", state)}
                  className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted"
                >
                  ← Back
                </Link>
                <Link
                  to="/dashboard"
                  className="ml-auto text-xs text-muted-foreground hover:text-foreground"
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
