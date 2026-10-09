// The GitHub repository picker and the "import started" screen, shared by a
// Doco's own GitHub page and the GitHub setup page (which brings several
// things into several Docos at once).
import { ArrowUpRight } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { Form, Link } from "react-router";
import { NarrowPageMain } from "~/components/page-main";
import type { GitHubInstallationChoice } from "~/lib/github-connection.server";

// Doco's raised "neu-button" affordance — primary (filled) and neutral variants.
export const PRIMARY_BTN =
  "neu-button inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-55";
export const NEUTRAL_BTN = "neu-button rounded-md px-2.5 py-1 text-xs font-medium";

export type InstallationPickerChoice = GitHubInstallationChoice & {
  selectableRepositories: string[];
  connectedRepositories: string[];
  isInstallationConnected: boolean;
};

export function buildInstallationPickerChoices(
  choices: GitHubInstallationChoice[],
  connectedRepos: Set<string>,
  connectedInstallationIds = new Set<number>(),
): InstallationPickerChoice[] {
  return choices.map((choice) => ({
    ...choice,
    selectableRepositories: choice.repositories.filter((repo) => !connectedRepos.has(repo)),
    connectedRepositories: choice.repositories.filter((repo) => connectedRepos.has(repo)),
    isInstallationConnected: connectedInstallationIds.has(choice.installation_id),
  }));
}

/** The organizations still worth offering: every one not yet connected as a
 *  whole, since picking it brings the rest of its repositories and the ones
 *  added later. Pure. */
export function addableInstallationChoices(
  choices: InstallationPickerChoice[],
): InstallationPickerChoice[] {
  return choices.filter((choice) => !choice.isInstallationConnected);
}

/** What "For all repositories" brings from an organization. A "selected"
 *  installation sees only the repositories chosen for Doco in GitHub. */
function allRepositoriesHint(choice: GitHubInstallationChoice): string {
  const count = choice.repositories.length > 0 ? ` ${choice.repositories.length}` : "";
  return choice.repository_selection === "all"
    ? `All${count}, including ones added later`
    : `All${count} Doco can see, including ones you give it later`;
}

/** What the connect button says for what is picked. Pure. */
export function connectLabel(repos: number, wholeAccounts: string[]): string {
  const parts = [
    ...(repos > 0 ? [`${repos} ${repos === 1 ? "repository" : "repositories"}`] : []),
    ...wholeAccounts.map((account) => `every repository in ${account}`),
  ];
  return parts.length === 0
    ? "Connect repositories"
    : `Connect ${new Intl.ListFormat("en", { type: "conjunction" }).format(parts)}`;
}

/** How an organization is brought: whole ("all", which also brings the
 *  repositories added to it later) or by the repositories ticked under it. */
type Scope = "all" | "select";

/**
 * Every organization the user can connect, each with two options: For all
 * repositories (one click for an organization of a hundred repositories) or
 * Select repositories, which lists its repositories to tick. One form, one
 * button: it posts `intent=connect` with the ticked `repo`s and the
 * `installation` of each organization brought whole. An organization with
 * neither option chosen brings nothing. `fields` ride along as hidden inputs,
 * and `aside` sits next to the button (a way to skip the step, say).
 */
export function RepositoryPicker({
  choices,
  installUrl,
  fields = [],
  aside,
}: {
  choices: InstallationPickerChoice[];
  installUrl: string | null;
  fields?: Array<[name: string, value: string]>;
  aside?: ReactNode;
}) {
  const [scopes, setScopes] = useState<Record<number, Scope>>({});
  // Kept while an organization is switched to For all repositories, so
  // switching back finds them ticked; only a listed repository is posted.
  const [ticked, setTicked] = useState<string[]>([]);
  const pickedRepos = choices
    .filter((choice) => scopes[choice.installation_id] === "select")
    .flatMap((choice) => choice.selectableRepositories)
    .filter((repo) => ticked.includes(repo)).length;
  const wholeAccounts = choices
    .filter((choice) => scopes[choice.installation_id] === "all")
    .map((choice) => choice.account);
  const grantMore = installUrl ? (
    <a href={installUrl} className="inline-flex items-center gap-1 font-semibold text-primary">
      Give Doco access to it in GitHub
      <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
    </a>
  ) : null;

  if (choices.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Every repository Doco can see is already connected.{" "}
        {grantMore ? <>Missing one? {grantMore}</> : null}
      </p>
    );
  }

  return (
    <Form method="post" className="space-y-4">
      <input type="hidden" name="intent" value="connect" />
      {fields.map(([name, value]) => (
        <input key={`${name}=${value}`} type="hidden" name={name} value={value} />
      ))}
      {choices.map((choice) => {
        const id = choice.installation_id;
        const scope = scopes[id];
        const choose = (next: Scope) => setScopes((current) => ({ ...current, [id]: next }));
        return (
          <fieldset key={id} className="space-y-2">
            <legend className="font-mono text-sm font-semibold text-foreground">
              {choice.account}
            </legend>
            {choice.repositories_unavailable ? (
              <p className="text-[11px] text-muted-foreground">
                GitHub didn&apos;t answer, so only the repositories Doco already knows are listed.
              </p>
            ) : null}
            <div className="grid gap-2 sm:grid-cols-2">
              <ScopeOption
                name={`scope:${id}`}
                value="all"
                checked={scope === "all"}
                onChoose={() => choose("all")}
                label="For all repositories"
                hint={allRepositoriesHint(choice)}
              />
              <ScopeOption
                name={`scope:${id}`}
                value="select"
                checked={scope === "select"}
                onChoose={() => choose("select")}
                label="Select repositories"
                hint="Only the ones you pick"
              />
            </div>
            {scope === "all" ? <input type="hidden" name="installation" value={id} /> : null}
            {scope === "select" ? (
              choice.selectableRepositories.length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  {choice.selectableRepositories.map((repo) => (
                    <RepositoryCheckbox
                      key={repo}
                      repo={repo}
                      checked={ticked.includes(repo)}
                      onToggle={() =>
                        setTicked((current) =>
                          current.includes(repo)
                            ? current.filter((r) => r !== repo)
                            : [...current, repo],
                        )
                      }
                    />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Every repository here is already connected.
                </p>
              )
            ) : null}
          </fieldset>
        );
      })}
      {grantMore ? (
        <p className="text-xs text-muted-foreground">Don&apos;t see a repository? {grantMore}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <button
          type="submit"
          className={PRIMARY_BTN}
          disabled={pickedRepos + wholeAccounts.length === 0}
        >
          {connectLabel(pickedRepos, wholeAccounts)}
        </button>
        {aside}
      </div>
    </Form>
  );
}

/** One of an organization's two options, a key that sits pressed once chosen. */
function ScopeOption({
  name,
  value,
  checked,
  onChoose,
  label,
  hint,
}: {
  name: string;
  value: Scope;
  checked: boolean;
  onChoose: () => void;
  label: string;
  hint: string;
}) {
  return (
    <label
      className={`neu-button${checked ? " neu-pressed" : ""} flex min-w-0 cursor-pointer items-start gap-2 rounded-md px-3 py-2 text-sm`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChoose}
        className="mt-1 h-3.5 w-3.5 shrink-0 accent-primary"
      />
      <span className="min-w-0">
        <span className="block font-semibold">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function RepositoryCheckbox({
  repo,
  checked,
  onToggle,
}: {
  repo: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="neu-button flex min-w-0 cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs">
      <input
        type="checkbox"
        name="repo"
        value={repo}
        checked={checked}
        onChange={onToggle}
        className="h-3.5 w-3.5 shrink-0 accent-primary"
      />
      <span className="min-w-0 flex-1 truncate font-mono" title={repo}>
        {repo}
      </span>
    </label>
  );
}

const ERROR_NOTICE =
  "rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive";

const SETUP_NOTICES: Record<string, { text: string; error: boolean }> = {
  forbidden: { text: "You need write access to connect this doco.", error: true },
  setup_failed: {
    text: "GitHub setup didn't complete — check the App credentials (App ID and private key) in the deployment environment, then try Connect again.",
    error: true,
  },
  setup_error: { text: "GitHub setup didn't complete. Try Connect again.", error: true },
  authorization_required: {
    text: "GitHub didn't confirm who installed the App, so the connection wasn't saved. Run Connect again and approve the GitHub authorization step.",
    error: true,
  },
  installation_not_yours: {
    text: "Your GitHub account can't access that installation, so it wasn't connected.",
    error: true,
  },
  signin_required: { text: "Sign in, then run Connect again.", error: true },
  connected: { text: "GitHub is connected. Choose the repositories below.", error: false },
  requested: {
    text: "GitHub sent your request to the organization's owners. Once one of them approves it, its repositories show up here.",
    error: false,
  },
};

/** What the GitHub install callback reported (`?github=<outcome>`), if anything. */
export function GitHubSetupNotice({ outcome }: { outcome: string | null }) {
  const notice = outcome ? SETUP_NOTICES[outcome] : undefined;
  if (!notice) return null;
  return (
    <p
      className={
        notice.error
          ? ERROR_NOTICE
          : "neu-well rounded-md bg-background p-3 text-sm text-foreground"
      }
    >
      {notice.text}
    </p>
  );
}

/** An action's error or confirmation. */
export function ActionNotice({ data }: { data: { error: string } | { message: string } | null }) {
  if (!data) return null;
  return "error" in data ? (
    <p className={ERROR_NOTICE}>{data.error}</p>
  ) : (
    <p className="neu-well rounded-md bg-background p-3 text-sm text-green-600">{data.message}</p>
  );
}

/**
 * The standalone screen right after repositories are connected (a PRG
 * redirect from the connect action): one clear message naming (and linking)
 * each Doco the import fills, and one Continue to the workspace, where its
 * setup takes the next step. Only an organization picked whole brings its
 * later repositories. Issues come only from the repositories that use GitHub
 * issues (`issueRepos` of them, when issues were chosen), so it says when
 * that is fewer than were picked.
 */
export function GitHubImportStarted({
  workspaceHandle,
  count,
  orgs,
  docos,
  issueRepos,
}: {
  workspaceHandle: string;
  count: number;
  orgs: string[];
  docos: Array<{ handle: string; items: string }>;
  issueRepos: number | null;
}) {
  const list = new Intl.ListFormat("en", { type: "conjunction" });
  const repositories = `${count} ${count === 1 ? "repository" : "repositories"}`;
  const continueLink = (
    <Link to={`/workspaces/${workspaceHandle}`} className={`${PRIMARY_BTN} mt-2`}>
      Continue
    </Link>
  );
  if (docos.length === 0) {
    return (
      <NarrowPageMain className="py-16">
        <div className="flex flex-col items-center gap-4 text-center">
          <h1 className="text-2xl font-semibold">Nothing to import</h1>
          <p className="text-sm text-muted-foreground">
            None of the {repositories} you picked use GitHub issues.
          </p>
          {continueLink}
        </div>
      </NarrowPageMain>
    );
  }
  const issuesNote =
    issueRepos === null || count === 0 || issueRepos >= count
      ? null
      : issueRepos === 0
        ? " None of them use GitHub issues, so no issues come over."
        : issueRepos === 1
          ? " Only 1 of them uses GitHub issues, so issues come from that one."
          : ` Only ${issueRepos} of them use GitHub issues, so issues come from those.`;
  return (
    <NarrowPageMain className="py-16">
      <div className="flex flex-col items-center gap-4 text-center">
        <h1 className="text-2xl font-semibold">Import started in the background</h1>
        <p className="text-sm text-muted-foreground">
          Importing{" "}
          {docos.map((d, i) => (
            <Fragment key={d.handle}>
              {i > 0 ? (i === docos.length - 1 ? " and " : ", ") : null}
              {d.items} into{" "}
              <Link to={`/${d.handle}`} className="font-mono font-semibold">
                {d.handle}
              </Link>
            </Fragment>
          ))}
          {count > 0 ? (
            <>
              {" "}
              from <span className="font-mono font-semibold tabular-nums">{count}</span>{" "}
              {count === 1 ? "repository" : "repositories"}
            </>
          ) : null}
          .{issuesNote} You can keep working; they&apos;ll appear as they sync.
          {orgs.length > 0
            ? ` Repositories added to ${list.format(orgs)} later come in too.`
            : null}
        </p>
        {continueLink}
      </div>
    </NarrowPageMain>
  );
}
