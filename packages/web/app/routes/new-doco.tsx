import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import { Breadcrumb, hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { DOCO_TEMPLATES } from "~/lib/doco-templates-meta";
import {
  HANDLE_FORMAT_HELP,
  HANDLE_INPUT_PATTERN,
  friendlyHandleValidationError,
  handleValidityMessage,
} from "~/lib/handle-format";
import { isOrgMember, listMyOrgs, lookupOrgHandle } from "~/lib/org-helpers.server";
import { withCreatedDocoId } from "~/lib/post-create-doco-route";
import {
  addOrganizationByHandle,
  createDocoInOrg,
  ensurePersonalOrganization,
  findAvailableDocoHandle,
} from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session.server";

/**
 * /new-doco — doco creation form.
 *
 * Captures the template, org, doco name, and privacy settings in one
 * form. Submitting creates the Doco immediately, then redirects to the
 * post-create concepts page.
 *
 * Flow map:
 *   /new-doco                  Create the Doco
 *   /:handle/welcome           Key Doco concepts
 *   /:handle/onboarding/agent  Bootstrap and collaborate
 */

const DEFAULT_TEMPLATE_HANDLE = "generic";

interface CreationState {
  templateHandle: string;
  orgId: string;
  newOrgHandle: string;
  suffix: string;
  visibility: "private" | "public";
}

interface ActionData {
  error?: string;
  suggestedHandle?: string | null;
  state?: CreationState;
}

function normalizeTemplateHandle(value: string): string {
  return DOCO_TEMPLATES.some((template) => template.handle === value)
    ? value
    : DEFAULT_TEMPLATE_HANDLE;
}

function parseVisibility(value: unknown): "private" | "public" {
  return value === "public" ? "public" : "private";
}

function readDocoName(params: URLSearchParams): string {
  return (
    params.get("suffix") ??
    params.get("name") ??
    params.get("doco_name") ??
    params.get("requested_suffix") ??
    ""
  );
}

function parseFormState(form: FormData): CreationState {
  return {
    templateHandle: normalizeTemplateHandle(String(form.get("template_handle") ?? "").trim()),
    orgId: String(form.get("org_id") ?? "").trim(),
    newOrgHandle: String(form.get("new_org_handle") ?? "")
      .trim()
      .toLowerCase(),
    suffix: String(form.get("suffix") ?? form.get("name") ?? "")
      .trim()
      .toLowerCase(),
    visibility: parseVisibility(form.get("visibility")),
  };
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");
  await ensurePersonalOrganization(me.id, me.username);
  const orgs = await listMyOrgs(me.id);
  const url = new URL(request.url);
  const prefill: CreationState = {
    templateHandle: normalizeTemplateHandle(url.searchParams.get("template_handle") ?? ""),
    orgId: url.searchParams.get("org_id") ?? "",
    newOrgHandle: url.searchParams.get("new_org_handle") ?? "",
    suffix: readDocoName(url.searchParams),
    visibility: parseVisibility(url.searchParams.get("visibility")),
  };
  return {
    me,
    orgs,
    prefill,
  };
}

export async function action({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");

  const form = await request.formData();
  const state = parseFormState(form);
  const accept = form.get("accept_suggested_handle") === "1";

  if (!state.templateHandle) {
    return { error: "Pick a primitives template.", suggestedHandle: null, state };
  }
  if (!state.orgId && !state.newOrgHandle) {
    return { error: "Pick an organization or create a new one.", suggestedHandle: null, state };
  }
  if (!state.suffix) {
    return { error: "Doco name is required.", suggestedHandle: null, state };
  }

  let chosenOrgId: string;
  let chosenOrgHandle: string;
  try {
    if (state.orgId) {
      if (!(await isOrgMember(state.orgId, me.id))) {
        return {
          error: "You are not a member of this organization.",
          suggestedHandle: null,
          state,
        };
      }
      const handle = await lookupOrgHandle(state.orgId);
      if (!handle) {
        return { error: "Organization not found.", suggestedHandle: null, state };
      }
      chosenOrgId = state.orgId;
      chosenOrgHandle = handle;
    } else {
      const created = await addOrganizationByHandle({
        handle: state.newOrgHandle,
        ownerCollaboratorId: me.id,
        autoSuffix: true,
      });
      chosenOrgId = created.id;
      chosenOrgHandle = created.handle;
    }
  } catch (e) {
    return {
      error: friendlyHandleValidationError((e as Error).message, "Organization handle"),
      suggestedHandle: null,
      state,
    };
  }

  try {
    const rec = await createDocoInOrg({
      orgId: chosenOrgId,
      requestedSuffix: state.suffix,
      createdByCollaboratorId: me.id,
      visibility: state.visibility,
      templateHandle:
        state.templateHandle === DEFAULT_TEMPLATE_HANDLE ? null : state.templateHandle,
      autoSuffix: accept,
    });
    throw redirect(withCreatedDocoId(`/${rec.handle}/welcome`, rec.docoId));
  } catch (e) {
    if (e instanceof Response) throw e;
    const message = (e as Error).message;
    if (!accept && message.includes("already taken")) {
      const suggestion = await findAvailableDocoHandle(chosenOrgHandle, state.suffix);
      return {
        error: `Handle "${chosenOrgHandle}-${state.suffix}" is already taken. Suggested: "${suggestion}".`,
        suggestedHandle: suggestion,
        state,
      };
    }
    return {
      error: friendlyHandleValidationError(message, "Doco name"),
      suggestedHandle: null,
      state,
    };
  }
}

export function meta() {
  return [{ title: "New doco · Doco" }];
}

export default function NewDocoStep1({
  loaderData,
  actionData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
  actionData?: ActionData;
}) {
  const { me, orgs, prefill } = loaderData;
  const formState = actionData?.state ?? prefill;
  const initialOrgId = formState.orgId || orgs[0]?.id || "";
  const [templateHandle, setTemplateHandle] = useState(
    normalizeTemplateHandle(formState.templateHandle),
  );
  const [orgId, setOrgId] = useState(initialOrgId);
  const [newOrgHandle, setNewOrgHandle] = useState(formState.newOrgHandle);
  const [suffix, setSuffix] = useState(formState.suffix);
  const [visibility, setVisibility] = useState(formState.visibility);
  const isCreateNewOrg = orgId === "";
  const orgHandleDisplay = isCreateNewOrg
    ? newOrgHandle || "<org>"
    : (orgs.find((o) => o.id === orgId)?.handle ?? "<org>");

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Breadcrumb
          items={hostBreadcrumb({
            section: { label: "Docos", to: "/dashboard" },
            pageLabel: "New doco",
          })}
        />
        <header>
          <h1 className="text-2xl font-semibold">New doco</h1>
        </header>
        <Card>
          <CardContent className="pt-4">
            <Form method="post" className="space-y-5">
              <fieldset className="space-y-2">
                <legend className="text-sm font-semibold text-foreground">
                  With this new doco, do you want to document something in particular?
                </legend>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {DOCO_TEMPLATES.map((template) => (
                    <label
                      key={template.handle}
                      className="neu-button flex cursor-pointer items-start gap-2 rounded-md p-2"
                    >
                      <input
                        type="radio"
                        name="template_handle"
                        value={template.handle}
                        checked={templateHandle === template.handle}
                        onChange={(e) => setTemplateHandle(e.currentTarget.value)}
                        className="mt-0.5"
                      />
                      <span className="block">
                        <span className="block text-sm font-semibold">{template.label}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {template.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  Organization
                </legend>
                <select
                  name="org_id"
                  value={orgId}
                  onChange={(e) => setOrgId(e.target.value)}
                  className="rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
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
                  <>
                    <input
                      type="text"
                      name="new_org_handle"
                      required
                      pattern={HANDLE_INPUT_PATTERN}
                      value={newOrgHandle}
                      onChange={(e) => setNewOrgHandle(e.target.value.toLowerCase())}
                      onInvalid={(event) => {
                        event.currentTarget.setCustomValidity(
                          handleValidityMessage(
                            event.currentTarget.validity,
                            "Organization handle",
                          ),
                        );
                      }}
                      onInput={(event) => event.currentTarget.setCustomValidity("")}
                      placeholder="Organization handle"
                      title={HANDLE_FORMAT_HELP}
                      aria-describedby="new-doco-org-handle-help"
                      className="w-full rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    />
                    <span
                      id="new-doco-org-handle-help"
                      className="block text-[11px] text-muted-foreground"
                    >
                      {HANDLE_FORMAT_HELP}
                    </span>
                  </>
                ) : null}
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  Doco name
                </legend>
                <input
                  type="text"
                  name="suffix"
                  required
                  pattern={HANDLE_INPUT_PATTERN}
                  value={suffix}
                  onChange={(e) => setSuffix(e.target.value.toLowerCase())}
                  onInvalid={(event) => {
                    event.currentTarget.setCustomValidity(
                      handleValidityMessage(event.currentTarget.validity, "Doco name"),
                    );
                  }}
                  onInput={(event) => event.currentTarget.setCustomValidity("")}
                  placeholder=""
                  title={HANDLE_FORMAT_HELP}
                  aria-describedby="new-doco-suffix-help"
                  className="w-[20ch] rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span
                  id="new-doco-suffix-help"
                  className="mt-1 block text-[11px] text-muted-foreground"
                >
                  {HANDLE_FORMAT_HELP}
                </span>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Final handle:{" "}
                  <code data-testid="handle-preview">
                    {orgHandleDisplay}-{suffix || "<suffix>"}
                  </code>
                </span>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  Visibility
                </legend>
                <select
                  name="visibility"
                  value={visibility}
                  onChange={(e) => setVisibility(e.currentTarget.value as "private" | "public")}
                  className="rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="private">Private</option>
                  <option value="public">Public</option>
                </select>
                <span className="mt-1 block text-[11px] text-muted-foreground">
                  Private docos return 403 to non-members on both the web and the API.
                </span>
              </fieldset>

              {actionData?.error ? (
                <p className="text-xs text-destructive">{actionData.error}</p>
              ) : null}
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold"
                >
                  Create doco
                </button>
                {actionData?.suggestedHandle ? (
                  <button
                    type="submit"
                    name="accept_suggested_handle"
                    value="1"
                    className="neu-button rounded-md px-4 py-2 text-sm"
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
