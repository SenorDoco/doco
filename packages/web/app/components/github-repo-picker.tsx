// The GitHub repository picker and the "import started" screen, shared by a
// Doco's own GitHub page and the GitHub setup page (which brings several
// things into several Docos at once).
import { Fragment, useState } from "react";
import { Form, Link } from "react-router";
import { SiteHeader } from "~/components/site-header";
import type { GitHubInstallationChoice } from "~/lib/github-connection.server";
import type { CurrentPrincipal } from "~/lib/session.server";

// Doco's raised "neu-button" affordance — primary (filled) and neutral variants.
export const PRIMARY_BTN =
  "neu-button inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-55";
export const NEUTRAL_BTN =
  "neu-button rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-input hover:text-foreground";

export type InstallationPickerChoice = GitHubInstallationChoice & {
  selectableRepositories: string[];
  connectedRepositories: string[];
  hasSelectableRepositories: boolean;
  canConnectInstallation: boolean;
  isInstallationConnected: boolean;
};

export function buildInstallationPickerChoices(
  choices: GitHubInstallationChoice[],
  connectedRepos: Set<string>,
  connectedInstallationIds = new Set<number>(),
): InstallationPickerChoice[] {
  return choices.map((choice) => {
    const connectedRepositories = choice.repositories.filter((repo) => connectedRepos.has(repo));
    const selectableRepositories = choice.repositories.filter((repo) => !connectedRepos.has(repo));
    const isInstallationConnected = connectedInstallationIds.has(choice.installation_id);
    return {
      ...choice,
      selectableRepositories,
      connectedRepositories,
      hasSelectableRepositories: selectableRepositories.length > 0,
      canConnectInstallation:
        !isInstallationConnected &&
        choice.repository_selection === "all" &&
        selectableRepositories.length === 0 &&
        connectedRepositories.length === 0,
      isInstallationConnected,
    };
  });
}

/** The choices still worth offering: org groups with repos left to pick, or
 *  an empty all-repos org to attach. Orgs fully connected drop out. Pure. */
export function addableInstallationChoices(
  choices: InstallationPickerChoice[],
): InstallationPickerChoice[] {
  return choices.filter(
    (choice) =>
      !choice.isInstallationConnected &&
      (choice.hasSelectableRepositories || choice.canConnectInstallation),
  );
}

/**
 * One GitHub org's repositories as checkboxes, posting `connect-existing-repos`
 * with the picked `repo`s, or `connect-installation` for an all-repositories
 * org GitHub lists no names for. `fields` rides along as hidden inputs.
 */
export function InstallationChoiceForm({
  choice,
  fields = [],
}: {
  choice: InstallationPickerChoice;
  fields?: Array<[name: string, value: string]>;
}) {
  const [selectedCount, setSelectedCount] = useState(0);

  return (
    <Form
      method="post"
      className="space-y-3"
      onChange={(event) => {
        setSelectedCount(event.currentTarget.querySelectorAll('input[name="repo"]:checked').length);
      }}
    >
      {fields.map(([name, value]) => (
        <input key={`${name}=${value}`} type="hidden" name={name} value={value} />
      ))}
      <input type="hidden" name="installation_id" value={choice.installation_id} />
      <div className="space-y-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="font-mono text-sm font-semibold text-foreground">{choice.account}</p>
            {choice.repositories_unavailable ? (
              <p className="text-[11px] text-muted-foreground">Showing known repositories only.</p>
            ) : null}
          </div>
          {choice.hasSelectableRepositories ? (
            <button
              type="submit"
              name="intent"
              value="connect-existing-repos"
              className={PRIMARY_BTN}
              disabled={selectedCount === 0}
            >
              {selectedCount > 0
                ? `Add ${selectedCount} ${selectedCount === 1 ? "repo" : "repos"}`
                : "Select repos"}
            </button>
          ) : choice.canConnectInstallation ? (
            <button
              type="submit"
              name="intent"
              value="connect-installation"
              className={PRIMARY_BTN}
            >
              Add all repositories
            </button>
          ) : null}
        </div>
        {choice.selectableRepositories.length > 0 ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {choice.selectableRepositories.map((repo) => (
              <label
                key={repo}
                className="flex min-w-0 items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-xs"
              >
                <input
                  type="checkbox"
                  name="repo"
                  value={repo}
                  className="h-3.5 w-3.5 shrink-0 accent-primary"
                />
                <span className="min-w-0 flex-1 truncate font-mono" title={repo}>
                  {repo}
                </span>
              </label>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {choice.canConnectInstallation
              ? "All repositories are allowed for this GitHub account."
              : "No repositories are available from this GitHub organization yet."}
          </p>
        )}
      </div>
    </Form>
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
          : "rounded-md border border-border bg-background p-3 text-sm text-foreground"
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
    <p className="rounded-md border border-border bg-background p-3 text-sm text-green-600">
      {data.message}
    </p>
  );
}

/**
 * The standalone screen right after repositories are connected (a PRG
 * redirect from the connect action): one clear message, and a way into each
 * Doco the import fills.
 */
export function GitHubImportStarted({
  me,
  count,
  docos,
}: {
  me: CurrentPrincipal | null;
  count: number;
  docos: Array<{ handle: string; items: string }>;
}) {
  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-xl px-6 py-16">
        <div className="flex flex-col items-center gap-4 text-center">
          <span
            aria-hidden
            className="h-8 w-8 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
          />
          <h1 className="text-2xl font-semibold">Import started</h1>
          <p className="text-sm text-muted-foreground">
            Importing{" "}
            {docos.map((d, i) => (
              <Fragment key={d.handle}>
                {i > 0 ? (i === docos.length - 1 ? " and " : ", ") : null}
                {d.items} into <span className="font-mono font-semibold">{d.handle}</span>
              </Fragment>
            ))}
            {count > 0 ? (
              <>
                {" "}
                from <span className="font-mono font-semibold tabular-nums">{count}</span>{" "}
                {count === 1 ? "repository" : "repositories"}
              </>
            ) : null}{" "}
            in the background. You can keep working — they&apos;ll appear as they sync, and new
            repos in the organization sync automatically.
          </p>
          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {docos.map((d) => (
              <Link key={d.handle} to={`/${d.handle}`} className={PRIMARY_BTN}>
                {docos.length === 1 ? "Continue" : `Open ${d.handle}`}
              </Link>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
