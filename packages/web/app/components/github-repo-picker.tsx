// The GitHub repository picker and the "import started" screen, shared by a
// Doco's own GitHub page and the GitHub setup page (which brings several
// things into several Docos at once).
import { ArrowUpRight } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
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

/** The checkbox that picks an organization as a whole. A "selected"
 *  installation sees only the repositories chosen for Doco in GitHub. */
function wholeAccountLabel(choice: GitHubInstallationChoice): string {
  const count = choice.repositories.length > 0 ? ` (${choice.repositories.length})` : "";
  return choice.repository_selection === "all"
    ? `Every repository in ${choice.account}${count}, including ones added later`
    : `Every repository Doco can see in ${choice.account}${count}, including ones you give it later`;
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

/**
 * Every repository the user can connect, grouped by GitHub organization, in
 * one form with one button: it posts `intent=connect` with the picked `repo`s
 * and the `installation` of each organization picked as a whole (one click for
 * an organization of a hundred repositories). `fields` ride along as hidden
 * inputs, and `aside` sits next to the button (a way to skip the step, say).
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
  const [picked, setPicked] = useState({
    repos: 0,
    installations: [] as string[],
    accounts: [] as string[],
  });
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
    <Form
      method="post"
      className="space-y-4"
      onChange={(event) => {
        const form = event.currentTarget;
        const whole = [
          ...form.querySelectorAll<HTMLInputElement>('input[name="installation"]:checked'),
        ];
        const installations = whole.map((input) => input.value);
        setPicked({
          // An organization picked as a whole hides its repositories.
          repos: [...form.querySelectorAll<HTMLInputElement>('input[name="repo"]:checked')].filter(
            (input) => !installations.includes(input.dataset.installation ?? ""),
          ).length,
          installations,
          accounts: whole.map((input) => input.dataset.account ?? ""),
        });
      }}
    >
      <input type="hidden" name="intent" value="connect" />
      {fields.map(([name, value]) => (
        <input key={`${name}=${value}`} type="hidden" name={name} value={value} />
      ))}
      {choices.map((choice) => (
        <fieldset key={choice.installation_id} className="space-y-2">
          <legend className="font-mono text-sm font-semibold text-foreground">
            {choice.account}
          </legend>
          {choice.repositories_unavailable ? (
            <p className="text-[11px] text-muted-foreground">
              GitHub didn&apos;t answer, so only the repositories Doco already knows are listed.
            </p>
          ) : null}
          <RepositoryCheckbox
            name="installation"
            value={String(choice.installation_id)}
            account={choice.account}
            label={wholeAccountLabel(choice)}
          />
          {choice.selectableRepositories.length > 0 &&
          !picked.installations.includes(String(choice.installation_id)) ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {choice.selectableRepositories.map((repo) => (
                <RepositoryCheckbox
                  key={repo}
                  name="repo"
                  value={repo}
                  label={repo}
                  installation={String(choice.installation_id)}
                />
              ))}
            </div>
          ) : null}
        </fieldset>
      ))}
      {grantMore ? (
        <p className="text-xs text-muted-foreground">Don&apos;t see a repository? {grantMore}</p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
        <button
          type="submit"
          className={PRIMARY_BTN}
          disabled={picked.repos + picked.accounts.length === 0}
        >
          {connectLabel(picked.repos, picked.accounts)}
        </button>
        {aside}
      </div>
    </Form>
  );
}

function RepositoryCheckbox({
  name,
  value,
  label,
  account,
  installation,
}: {
  name: string;
  value: string;
  label: string;
  account?: string;
  installation?: string;
}) {
  return (
    <label className="flex min-w-0 cursor-pointer items-center gap-2 rounded border border-border bg-card px-2 py-1.5 text-xs hover:bg-input">
      <input
        type="checkbox"
        name={name}
        value={value}
        data-account={account}
        data-installation={installation}
        className="h-3.5 w-3.5 shrink-0 accent-primary"
      />
      <span
        className={name === "repo" ? "min-w-0 flex-1 truncate font-mono" : "min-w-0 flex-1"}
        title={label}
      >
        {label}
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
  importing: {
    text: "GitHub is connected. Doco is importing in the background; each Doco shows how far it has got.",
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
