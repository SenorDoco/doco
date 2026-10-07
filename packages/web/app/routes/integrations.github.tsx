// /integrations/github — setting up GitHub for a workspace. It asks which
// workspace and what to bring from GitHub (github-imports: pull requests,
// bugs, codebase; all picked to start), brings each choice into the
// workspace's Doco for it (creating the ones it lacks, github-setup), then
// has the person pick the repositories to bring them from. Every chosen Doco gets the same repositories, and each
// imports what it brings.
//
// Steps, all on this URL:
//   1. choose  → workspace + what to bring (POST intent=choose)
//   2. repos   → ?workspace=<handle>&bring=<id>… : pick repositories, or add
//                an organization in GitHub first
//   3. started → …&github=importing : the import runs in the background, and
//                the person goes back to the workspace
import { roleAtLeast } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { useState } from "react";
import { Form, Link, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { hostBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { DocoTypeIcon } from "~/components/doco-type-icon";
import {
  ActionNotice,
  GitHubImportStarted,
  GitHubSetupNotice,
  PRIMARY_BTN,
  RepositoryPicker,
  addableInstallationChoices,
  buildInstallationPickerChoices,
} from "~/components/github-repo-picker";
import { PageHeader } from "~/components/page-header";
import { PageMain } from "~/components/page-main";
import { getDocoLevelRole, listAccessibleDocoIdsForPrincipal } from "~/lib/doco-access.server";
import {
  buildInstallUrl,
  connectPicked,
  getDocoConnectionsContext,
  listGitHubInstallationChoicesForDocos,
  pickConnections,
} from "~/lib/github-connection.server";
import { GITHUB_IMPORTS, type GitHubImport } from "~/lib/github-imports";
import { type ImportTarget, ensureImportDocos, listImportDocos } from "~/lib/github-setup.server";
import { getCurrentPrincipal } from "~/lib/session.server";
import { listMyWorkspaces } from "~/lib/workspace-helpers.server";
import { kickBackfillRun } from "./api.github.backfill-run";

/** The choices named by `bring` values, in catalog order, each once. Pure. */
function parseBring(values: unknown[]): GitHubImport[] {
  const ids = new Set(values.map(String));
  return GITHUB_IMPORTS.filter((i) => ids.has(i.id));
}

/** The repositories step's URL for a workspace and its choices. Pure. */
function setupPath(workspaceHandle: string, imports: GitHubImport[]): string {
  const query = new URLSearchParams({ workspace: workspaceHandle });
  for (const i of imports) query.append("bring", i.id);
  return `/integrations/github?${query}`;
}

/** Items shared by every set, in the first set's order. Pure. */
function inEvery<T>(sets: T[][]): Set<T> {
  const [first = [], ...rest] = sets;
  return new Set(first.filter((x) => rest.every((s) => s.includes(x))));
}

async function signedIn(request: Request) {
  const me = await getCurrentPrincipal(request);
  if (!me) {
    const url = new URL(request.url);
    throw redirect(`/sign-in?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`);
  }
  return me;
}

async function installationChoicesFor(userId: string) {
  return listGitHubInstallationChoicesForDocos(await listAccessibleDocoIdsForPrincipal(userId));
}

export async function loader({ request }: { request: Request }) {
  const me = await signedIn(request);
  const url = new URL(request.url);
  const workspaces = await listMyWorkspaces(me.id);
  const docosByWorkspace = await listImportDocos(workspaces.map((w) => w.id));
  const workspace = workspaces.find((w) => w.handle === url.searchParams.get("workspace"));
  const bring = parseBring(url.searchParams.getAll("bring"));
  const existing = workspace ? (docosByWorkspace[workspace.id] ?? {}) : {};
  const targets: ImportTarget[] = bring.flatMap((i) =>
    existing[i.id] ? [{ import: i, doco: existing[i.id] }] : [],
  );

  if (!workspace || bring.length === 0 || targets.length < bring.length) {
    return {
      step: "choose" as const,
      workspaceHandle: workspace?.handle ?? (workspaces.length === 1 ? workspaces[0].handle : null),
      // Everything starts picked, so one setup brings it all into its Docos.
      bring: (bring.length > 0 ? bring : GITHUB_IMPORTS).map((i) => i.id),
      workspaces: workspaces.map((w) => ({ ...w, docos: docosByWorkspace[w.id] ?? {} })),
    };
  }

  // A repository (or an all-repositories org) counts as connected only when
  // every chosen Doco already has it.
  const contexts = await Promise.all(targets.map((t) => getDocoConnectionsContext(t.doco.id)));
  const connectedRepos = inEvery(contexts.map((c) => (c?.connections ?? []).map((x) => x.repo)));
  const connectedInstallations = inEvery(
    contexts.map((c) => (c?.installations ?? []).map((x) => x.installation_id)),
  );
  return {
    step: "repos" as const,
    workspaceHandle: workspace.handle,
    bring: bring.map((i) => i.id),
    targets,
    choices: addableInstallationChoices(
      buildInstallationPickerChoices(
        await installationChoicesFor(me.id),
        connectedRepos,
        connectedInstallations,
      ),
    ),
    installUrl: buildInstallUrl({
      userId: me.id,
      docoIds: targets.map((t) => t.doco.id),
      next: setupPath(workspace.handle, bring),
    }),
  };
}

type ActionResult = { error: string };

export async function action({ request }: { request: Request }): Promise<ActionResult> {
  const me = await signedIn(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const workspace = (await listMyWorkspaces(me.id)).find(
    (w) => w.handle === String(form.get("workspace") ?? ""),
  );
  if (!workspace) return { error: "Pick a workspace." };
  const bring = parseBring(form.getAll("bring"));
  if (bring.length === 0) return { error: "Pick at least one thing to bring from GitHub." };
  const next = setupPath(workspace.handle, bring);

  // Connecting a Doco to GitHub takes write access to it, whether it already
  // exists or the setup is about to create it (its creator owns it).
  const existing = (await listImportDocos([workspace.id]))[workspace.id] ?? {};
  for (const choice of bring) {
    const doco = existing[choice.id];
    if (!doco) continue;
    const role = await getDocoLevelRole({ ownerId: workspace.id, docoId: doco.id }, me.id);
    if (!roleAtLeast(role, "writer")) {
      return { error: `Bringing ${choice.items} into ${doco.handle} needs write access to it.` };
    }
  }

  if (intent === "choose") {
    const targets = await ensureImportDocos({ workspace, imports: bring, userId: me.id });
    if ((await installationChoicesFor(me.id)).length === 0) {
      const installUrl = buildInstallUrl({
        userId: me.id,
        docoIds: targets.map((t) => t.doco.id),
        next,
      });
      if (installUrl) throw redirect(installUrl);
    }
    throw redirect(next);
  }

  if (intent !== "connect") return { error: `Unknown action: ${intent}` };
  const docos = bring.map((choice) => existing[choice.id]);
  if (docos.some((doco) => !doco)) return { error: "Choose what to bring from GitHub again." };
  const picked = pickConnections(await installationChoicesFor(me.id), {
    repos: form.getAll("repo").map(String),
    installations: form.getAll("installation").map(String),
  });
  if ("error" in picked) return picked;
  const origin = new URL(request.url).origin;
  for (const doco of docos) {
    if (await connectPicked(doco.id, picked)) waitUntil(kickBackfillRun(origin, doco.id));
  }
  const started = new URLSearchParams({
    github: "importing",
    count: String(picked.connections.length),
  });
  for (const org of picked.installations) started.append("org", org.account);
  throw redirect(`${next}&${started}`);
}

export function meta() {
  return [{ title: "Set up GitHub · App integrations · Doco" }];
}

export default function GitHubSetup() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const outcome = searchParams.get("github");

  if (data.step === "repos" && outcome === "importing") {
    return (
      <GitHubImportStarted
        workspaceHandle={data.workspaceHandle}
        count={Number(searchParams.get("count") ?? 0)}
        orgs={searchParams.getAll("org")}
        docos={data.targets.map((t) => ({ handle: t.doco.handle, items: t.import.items }))}
      />
    );
  }

  return (
    <PageMain className="space-y-6 py-6">
      <PageHeader
        breadcrumb={hostBreadcrumb({
          section: { label: "App integrations", to: "/integrations" },
          pageLabel: "GitHub",
        })}
        title="Set up GitHub"
      >
        <p className="text-sm text-muted-foreground">
          Bring what you need from GitHub into a workspace. Each thing you bring comes into its own
          doco.
        </p>
      </PageHeader>
      <GitHubSetupNotice outcome={outcome} />
      <ActionNotice data={actionData ?? null} />
      {data.step === "choose" ? (
        <ChooseStep
          workspaces={data.workspaces}
          workspaceHandle={data.workspaceHandle}
          bring={data.bring}
        />
      ) : (
        <ReposStep
          workspaceHandle={data.workspaceHandle}
          bring={data.bring}
          targets={data.targets}
          choices={data.choices}
          installUrl={data.installUrl}
        />
      )}
    </PageMain>
  );
}

function ChooseStep({
  workspaces,
  workspaceHandle,
  bring,
}: {
  workspaces: Array<{ handle: string; docos: Record<string, { handle: string }> }>;
  workspaceHandle: string | null;
  bring: string[];
}) {
  const [selected, setSelected] = useState(workspaceHandle ?? "");
  const docos = workspaces.find((w) => w.handle === selected)?.docos ?? {};
  return (
    <Form method="post" className="space-y-6">
      <input type="hidden" name="intent" value="choose" />
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Workspace</CardTitle>
          <CardDescription>The workspace to bring GitHub into.</CardDescription>
        </CardHeader>
        <CardContent>
          <select
            name="workspace"
            value={selected}
            onChange={(event) => setSelected(event.currentTarget.value)}
            className="w-full rounded-md bg-background px-3 py-2 text-sm"
            required
          >
            <option value="">Choose a workspace</option>
            {workspaces.map((w) => (
              <option key={w.handle} value={w.handle}>
                {w.handle}
              </option>
            ))}
          </select>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">What do you want to bring from GitHub?</CardTitle>
          <CardDescription>Pick one or more.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {GITHUB_IMPORTS.map((choice) => (
            <label
              key={choice.id}
              className="neu-button flex items-start gap-3 rounded-md p-3 text-sm"
            >
              <input
                type="checkbox"
                name="bring"
                value={choice.id}
                defaultChecked={bring.includes(choice.id)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <DocoTypeIcon template={choice.template} className="mt-0.5 text-muted-foreground" />
              <span className="min-w-0 space-y-0.5">
                <span className="block font-semibold text-foreground">{choice.label}</span>
                <span className="block text-xs text-muted-foreground">{choice.description}</span>
                {selected ? (
                  <span className="block text-xs text-muted-foreground">
                    Into{" "}
                    {docos[choice.id] ? (
                      <span className="font-mono text-foreground">{docos[choice.id].handle}</span>
                    ) : (
                      <>
                        a new doco,{" "}
                        <span className="font-mono text-foreground">
                          {selected}-{choice.id}
                        </span>
                      </>
                    )}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </CardContent>
      </Card>
      <button type="submit" className={PRIMARY_BTN}>
        Continue
      </button>
    </Form>
  );
}

function ReposStep({
  workspaceHandle,
  bring,
  targets,
  choices,
  installUrl,
}: {
  workspaceHandle: string;
  bring: string[];
  targets: ImportTarget[];
  choices: ReturnType<typeof addableInstallationChoices>;
  installUrl: string | null;
}) {
  const fields: Array<[string, string]> = [
    ["workspace", workspaceHandle],
    ...bring.map((id): [string, string] => ["bring", id]),
  ];
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Bringing into {workspaceHandle}</CardTitle>
          <CardDescription>
            <Link
              to={`/integrations/github?workspace=${encodeURIComponent(workspaceHandle)}`}
              className="text-primary hover:underline"
            >
              Change what to bring
            </Link>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-1.5">
            {targets.map((t) => (
              <li key={t.import.id} className="flex items-center gap-2 text-sm">
                <DocoTypeIcon template={t.import.template} className="text-muted-foreground" />
                <span className="font-semibold text-foreground">{t.import.label}</span>
                <span className="text-muted-foreground">into</span>
                <Link to={`/${t.doco.handle}`} className="font-mono">
                  {t.doco.handle}
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pick repositories</CardTitle>
          <CardDescription>Each doco above brings its part from them.</CardDescription>
        </CardHeader>
        <CardContent>
          <RepositoryPicker choices={choices} installUrl={installUrl} fields={fields} />
        </CardContent>
      </Card>
    </>
  );
}
