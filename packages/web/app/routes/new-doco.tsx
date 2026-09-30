import { useState } from "react";
import { Form, Link, redirect } from "react-router";
import { hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { DOCO_TEMPLATES } from "~/lib/doco-templates-meta";
import {
  HANDLE_FORMAT_HELP,
  HANDLE_INPUT_PATTERN,
  friendlyHandleValidationError,
  handleValidityMessage,
} from "~/lib/handle-format";
import { withCreatedDocoId } from "~/lib/post-create-doco-route";
import {
  addWorkspaceByHandle,
  createDocoInWorkspace,
  ensurePersonalWorkspace,
  findAvailableDocoHandle,
} from "~/lib/redeem.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import {
  isWorkspaceMember,
  listMyWorkspaces,
  lookupWorkspaceHandle,
} from "~/lib/workspace-helpers.server";

/**
 * /new-doco — doco creation form.
 *
 * Captures the template, workspace, Doco handle, and privacy settings in one
 * form. Submitting creates the Doco immediately, then redirects to the
 * post-create concepts page.
 *
 * Flow map:
 *   /new-doco         Create the Doco
 *   /:handle/welcome  Key Doco concepts (Continue -> Doco home)
 *
 * There's no separate "Bootstrap and collaborate" step — invite and
 * API-key affordances are reachable from the Doco home page directly.
 */

const DEFAULT_TEMPLATE_HANDLE = "generic";
/** A Doco that fills from a source continues into connecting that source. */
const SOURCE_SETUP: Record<string, string> = {
  "github-pull-requests": "github",
  codebase: "github",
  slack: "slack",
  notion: "notion",
};

/**
 * Sentinel <option> value for "+ Create a new workspace". Kept
 * distinct from "" (the unselected placeholder) so a fresh form can
 * start with no workspace chosen without implying the create-new
 * flow.
 */
export const CREATE_NEW_WORKSPACE_VALUE = "__new_workspace__";

interface CreationState {
  templateHandle: string;
  workspaceId: string;
  newWorkspaceHandle: string;
  name: string;
  visibility: "private" | "public";
  goal: string;
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
    params.get("name") ??
    params.get("suffix") ??
    params.get("doco_name") ??
    params.get("requested_suffix") ??
    ""
  );
}

/**
 * Default goal for a template. Empty for "generic" (no template); the
 * chosen template's description text otherwise.
 */
function defaultGoalForTemplate(templateHandle: string): string {
  if (templateHandle === DEFAULT_TEMPLATE_HANDLE) return "";
  return DOCO_TEMPLATES.find((t) => t.handle === templateHandle)?.description ?? "";
}

/**
 * The Doco handle the form suggests: the workspace handle plus what the Doco
 * holds — the template's handle, or "doco" for a blank one ("torre-slack",
 * "torre-doco"). Empty until a workspace is chosen; always a valid handle.
 */
export function suggestedDocoHandle(workspaceHandle: string, templateHandle: string): string {
  if (!workspaceHandle) return "";
  const what = templateHandle === DEFAULT_TEMPLATE_HANDLE ? "doco" : templateHandle;
  return `${workspaceHandle}-${what}`.slice(0, 64).replace(/[-_]+$/, "");
}

/**
 * Initial value for the workspace <select>. An empty string means
 * "no workspace selected yet" — we deliberately do NOT default to
 * the user's first workspace, so picking one is a conscious choice. A
 * preserved new-workspace handle (e.g. after a failed submit) restores the
 * create-new flow.
 */
export function initialWorkspaceSelection(
  formState: Pick<CreationState, "workspaceId" | "newWorkspaceHandle">,
): string {
  if (formState.workspaceId) return formState.workspaceId;
  if (formState.newWorkspaceHandle) return CREATE_NEW_WORKSPACE_VALUE;
  return "";
}

function parseFormState(form: FormData): CreationState {
  const rawWorkspaceId = String(form.get("workspace_id") ?? "").trim();
  return {
    templateHandle: normalizeTemplateHandle(String(form.get("template_handle") ?? "").trim()),
    // The create-new sentinel collapses to an empty workspaceId; the action
    // then creates the workspace from new_workspace_handle.
    workspaceId: rawWorkspaceId === CREATE_NEW_WORKSPACE_VALUE ? "" : rawWorkspaceId,
    newWorkspaceHandle: String(form.get("new_workspace_handle") ?? "")
      .trim()
      .toLowerCase(),
    name: String(form.get("name") ?? form.get("suffix") ?? "")
      .trim()
      .toLowerCase(),
    visibility: parseVisibility(form.get("visibility")),
    goal: String(form.get("goal") ?? ""),
  };
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in?next=%2Fnew-doco");
  await ensurePersonalWorkspace(me.id, me.username);
  const workspaces = await listMyWorkspaces(me.id);
  const url = new URL(request.url);
  const prefillTemplate = normalizeTemplateHandle(url.searchParams.get("template_handle") ?? "");
  const prefill: CreationState = {
    templateHandle: prefillTemplate,
    workspaceId: url.searchParams.get("workspace_id") ?? "",
    newWorkspaceHandle: url.searchParams.get("new_workspace_handle") ?? "",
    name: readDocoName(url.searchParams),
    visibility: parseVisibility(url.searchParams.get("visibility")),
    goal: url.searchParams.get("goal") ?? defaultGoalForTemplate(prefillTemplate),
  };
  return {
    me,
    workspaces,
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
    return { error: "Pick a policies template.", suggestedHandle: null, state };
  }
  if (!state.workspaceId && !state.newWorkspaceHandle) {
    return { error: "Pick an workspace or create a new one.", suggestedHandle: null, state };
  }
  if (!state.name) {
    return { error: "Doco handle is required.", suggestedHandle: null, state };
  }

  let chosenWorkspaceId: string;
  try {
    if (state.workspaceId) {
      if (!(await isWorkspaceMember(state.workspaceId, me.id))) {
        return {
          error: "You are not a member of this workspace.",
          suggestedHandle: null,
          state,
        };
      }
      const handle = await lookupWorkspaceHandle(state.workspaceId);
      if (!handle) {
        return { error: "Workspace not found.", suggestedHandle: null, state };
      }
      chosenWorkspaceId = state.workspaceId;
    } else {
      const created = await addWorkspaceByHandle({
        handle: state.newWorkspaceHandle,
        ownerUserId: me.id,
        autoSuffix: true,
      });
      chosenWorkspaceId = created.id;
    }
  } catch (e) {
    return {
      error: friendlyHandleValidationError((e as Error).message, "Workspace handle"),
      suggestedHandle: null,
      state,
    };
  }

  try {
    const rec = await createDocoInWorkspace({
      workspaceId: chosenWorkspaceId,
      requestedHandle: state.name,
      createdByUserId: me.id,
      visibility: state.visibility,
      templateHandle:
        state.templateHandle === DEFAULT_TEMPLATE_HANDLE ? null : state.templateHandle,
      autoSuffix: accept,
      goal: state.goal,
    });
    const source = SOURCE_SETUP[state.templateHandle];
    if (source) throw redirect(`/${rec.handle}/integrations/${source}`);
    throw redirect(withCreatedDocoId(`/${rec.handle}/welcome`, rec.docoId));
  } catch (e) {
    if (e instanceof Response) throw e;
    const message = (e as Error).message;
    if (!accept && message.includes("already taken")) {
      const suggestion = await findAvailableDocoHandle(state.name);
      return {
        error: `Handle "${state.name}" is already taken. Suggested: "${suggestion}".`,
        suggestedHandle: suggestion,
        state,
      };
    }
    return {
      error: friendlyHandleValidationError(message, "Doco handle"),
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
  const { me, workspaces, prefill } = loaderData;
  const formState = actionData?.state ?? prefill;
  const initialWorkspaceId = initialWorkspaceSelection(formState);
  const initialTemplate = normalizeTemplateHandle(formState.templateHandle);
  const initialWorkspaceHandle =
    initialWorkspaceId === CREATE_NEW_WORKSPACE_VALUE
      ? formState.newWorkspaceHandle
      : (workspaces.find((o) => o.id === initialWorkspaceId)?.handle ?? "");
  const [templateHandle, setTemplateHandle] = useState(initialTemplate);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [newWorkspaceHandle, setNewWorkspaceHandle] = useState(formState.newWorkspaceHandle);
  const [name, setName] = useState(
    formState.name || suggestedDocoHandle(initialWorkspaceHandle, initialTemplate),
  );
  const [nameEdited, setNameEdited] = useState(Boolean(formState.name));
  const [visibility, setVisibility] = useState(formState.visibility);
  // Goal is prefilled with the chosen template's description and
  // tracks template changes — unless the user has edited it, in which
  // case we keep their text.
  const [goal, setGoal] = useState(formState.goal);
  const [goalEdited, setGoalEdited] = useState(
    formState.goal !== defaultGoalForTemplate(initialTemplate),
  );
  const workspaceHandleFor = (id: string, typedHandle: string) =>
    id === CREATE_NEW_WORKSPACE_VALUE
      ? typedHandle
      : (workspaces.find((o) => o.id === id)?.handle ?? "");
  const selectedWorkspaceHandle = workspaceHandleFor(workspaceId, newWorkspaceHandle);
  // The handle follows the workspace and template until the user types one.
  const handleTemplateChange = (value: string) => {
    const next = normalizeTemplateHandle(value);
    setTemplateHandle(next);
    if (!goalEdited) {
      setGoal(defaultGoalForTemplate(next));
    }
    if (!nameEdited) {
      setName(suggestedDocoHandle(selectedWorkspaceHandle, next));
    }
  };
  const isCreateNewWorkspace = workspaceId === CREATE_NEW_WORKSPACE_VALUE;
  const updateWorkspaceId = (value: string) => {
    setWorkspaceId(value);
    if (!nameEdited) {
      setName(suggestedDocoHandle(workspaceHandleFor(value, newWorkspaceHandle), templateHandle));
    }
  };
  const updateNewWorkspaceHandle = (value: string) => {
    const next = value.toLowerCase();
    setNewWorkspaceHandle(next);
    if (!nameEdited && workspaceId === CREATE_NEW_WORKSPACE_VALUE) {
      setName(suggestedDocoHandle(next, templateHandle));
    }
  };

  return (
    <div>
      <SiteHeader me={me} />
      <SingleColumnPageMain className="py-6 space-y-4">
        <PageHeader
          breadcrumb={hostBreadcrumb({
            section: { label: "Docos", to: "/workspaces" },
            pageLabel: "New doco",
          })}
          title="New doco"
        />
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
                        onChange={(e) => handleTemplateChange(e.currentTarget.value)}
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
                  Doco's goal
                </legend>
                <textarea
                  name="goal"
                  rows={3}
                  value={goal}
                  onChange={(e) => {
                    setGoal(e.currentTarget.value);
                    setGoalEdited(true);
                  }}
                  placeholder="What is this doco for? Agents read this first when they bootstrap."
                  className="w-full rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span className="block text-[11px] text-muted-foreground">
                  Templates prefill this; edit to make it your own.
                </span>
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  Workspace
                </legend>
                <select
                  name="workspace_id"
                  required
                  value={workspaceId}
                  onChange={(e) => updateWorkspaceId(e.target.value)}
                  className="rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                >
                  <option value="" disabled>
                    Select an workspace…
                  </option>
                  {workspaces.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.handle}
                      {o.handle === me.username ? " (personal)" : ""}
                    </option>
                  ))}
                  <option value={CREATE_NEW_WORKSPACE_VALUE}>+ Create a new workspace</option>
                </select>
                {isCreateNewWorkspace ? (
                  <>
                    <input
                      type="text"
                      name="new_workspace_handle"
                      required
                      pattern={HANDLE_INPUT_PATTERN}
                      value={newWorkspaceHandle}
                      onChange={(e) => updateNewWorkspaceHandle(e.target.value)}
                      onInvalid={(event) => {
                        event.currentTarget.setCustomValidity(
                          handleValidityMessage(event.currentTarget.validity, "Workspace handle"),
                        );
                      }}
                      onInput={(event) => event.currentTarget.setCustomValidity("")}
                      placeholder="Workspace handle"
                      title={HANDLE_FORMAT_HELP}
                      aria-describedby="new-doco-workspace-handle-help"
                      className="w-full rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                    />
                    <span
                      id="new-doco-workspace-handle-help"
                      className="block text-[11px] text-muted-foreground"
                    >
                      {HANDLE_FORMAT_HELP}
                    </span>
                  </>
                ) : null}
              </fieldset>

              <fieldset className="space-y-2">
                <legend className="text-xs font-semibold uppercase text-muted-foreground">
                  Doco handle
                </legend>
                <input
                  type="text"
                  name="name"
                  required
                  pattern={HANDLE_INPUT_PATTERN}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value.toLowerCase());
                    setNameEdited(true);
                  }}
                  onInvalid={(event) => {
                    event.currentTarget.setCustomValidity(
                      handleValidityMessage(event.currentTarget.validity, "Doco handle"),
                    );
                  }}
                  onInput={(event) => event.currentTarget.setCustomValidity("")}
                  placeholder={suggestedDocoHandle(selectedWorkspaceHandle, templateHandle)}
                  title={HANDLE_FORMAT_HELP}
                  aria-describedby="new-doco-name-help"
                  className="w-[60ch] max-w-full rounded-md px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <span
                  id="new-doco-name-help"
                  className="mt-1 block text-[11px] text-muted-foreground"
                >
                  {HANDLE_FORMAT_HELP}
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
                  to="/workspaces"
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
