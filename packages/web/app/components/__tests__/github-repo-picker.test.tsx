// @vitest-environment happy-dom
//
// Alexander, 2026-10-09: instead of one option for every repository with the
// whole list below it, each organization first offers two options, "For all
// repositories" and "Select repositories", and lists its repositories only
// once "Select repositories" is chosen.
import { act } from "react";
import type { ReactNode } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react-router", () => ({
  Form: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <form className={className}>{children}</form>
  ),
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
}));

import { type InstallationPickerChoice, RepositoryPicker } from "../github-repo-picker";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function choice(
  installation_id: number,
  account: string,
  repositories: string[],
  connected: string[] = [],
): InstallationPickerChoice {
  return {
    installation_id,
    account,
    repository_selection: "all",
    repositories: [...repositories, ...connected],
    connected_repositories: connected,
    source_doco_handles: [],
    selectableRepositories: repositories,
    connectedRepositories: connected,
    isInstallationConnected: false,
  };
}

const TORRE_LABS = choice(8, "torre-labs", ["torre-labs/heda", "torre-labs/vader"]);
const TORRENEGRA = choice(7, "torrenegra", ["torrenegra/doco"]);

function render(choices: InstallationPickerChoice[]) {
  return act(async () => root.render(<RepositoryPicker choices={choices} installUrl={null} />));
}

function organization(account: string): HTMLFieldSetElement {
  const found = [...container.querySelectorAll("fieldset")].find(
    (f) => f.querySelector("legend")?.textContent === account,
  );
  if (!found) throw new Error(`no ${account}`);
  return found;
}

function option(account: string, label: string): HTMLInputElement {
  const found = [...organization(account).querySelectorAll("label")].find((l) =>
    l.textContent?.startsWith(label),
  );
  const input = found?.querySelector<HTMLInputElement>('input[type="radio"]');
  if (!input) throw new Error(`no ${label} in ${account}`);
  return input;
}

const choose = (account: string, label: string) => act(async () => option(account, label).click());
const tick = (repo: string) =>
  act(async () =>
    container.querySelector<HTMLInputElement>(`input[name="repo"][value="${repo}"]`)?.click(),
  );

/** What the form posts, minus the fixed fields. */
function posted(): Array<[string, string]> {
  const form = container.querySelector("form") as HTMLFormElement;
  return [...new FormData(form).entries()]
    .map(([name, value]): [string, string] => [name, String(value)])
    .filter(([name]) => name === "repo" || name === "installation");
}

const repoCheckboxes = () =>
  [...container.querySelectorAll<HTMLInputElement>('input[name="repo"]')].map((i) => i.value);
const connectButton = () => container.querySelector('button[type="submit"]') as HTMLButtonElement;

describe("RepositoryPicker", () => {
  it("offers each organization For all repositories or Select repositories, neither chosen and no repository listed", async () => {
    await render([TORRE_LABS, TORRENEGRA]);

    for (const account of ["torre-labs", "torrenegra"]) {
      expect(option(account, "For all repositories").checked).toBe(false);
      expect(option(account, "Select repositories").checked).toBe(false);
    }
    expect(organization("torre-labs").textContent).toContain("All 2, including ones added later");
    expect(repoCheckboxes()).toEqual([]);
    expect(posted()).toEqual([]);
    expect(connectButton().disabled).toBe(true);
  });

  it("lists an organization's repositories only once Select repositories is chosen", async () => {
    await render([TORRE_LABS, TORRENEGRA]);

    await choose("torre-labs", "Select repositories");

    expect(repoCheckboxes()).toEqual(["torre-labs/heda", "torre-labs/vader"]);
    expect(connectButton().disabled).toBe(true);

    await tick("torre-labs/vader");

    expect(posted()).toEqual([["repo", "torre-labs/vader"]]);
    expect(connectButton().textContent).toBe("Connect 1 repository");
  });

  it("connects an organization as a whole with For all repositories, listing none of its repositories", async () => {
    await render([TORRE_LABS, TORRENEGRA]);

    await choose("torre-labs", "For all repositories");

    expect(repoCheckboxes()).toEqual([]);
    expect(posted()).toEqual([["installation", "8"]]);
    expect(connectButton().textContent).toBe("Connect every repository in torre-labs");
  });

  it("brings each organization its own way, and posts only what the chosen option shows", async () => {
    await render([TORRE_LABS, TORRENEGRA]);

    await choose("torre-labs", "Select repositories");
    await tick("torre-labs/heda");
    await choose("torrenegra", "Select repositories");
    await tick("torrenegra/doco");
    await choose("torrenegra", "For all repositories");

    expect(posted()).toEqual([
      ["repo", "torre-labs/heda"],
      ["installation", "7"],
    ]);
    expect(connectButton().textContent).toBe(
      "Connect 1 repository and every repository in torrenegra",
    );

    // Back to Select repositories, the repository ticked before is still ticked.
    await choose("torrenegra", "Select repositories");

    expect(posted()).toEqual([
      ["repo", "torre-labs/heda"],
      ["repo", "torrenegra/doco"],
    ]);
  });

  it("says so when every repository of an organization is already connected", async () => {
    await render([choice(8, "torre-labs", [], ["torre-labs/heda"])]);

    await choose("torre-labs", "Select repositories");

    expect(repoCheckboxes()).toEqual([]);
    expect(organization("torre-labs").textContent).toContain(
      "Every repository here is already connected.",
    );
  });

  // Alexander, 2026-10-09: "They shouldn't be side by side. They should be
  // one-column lists."
  it("stacks the options and the repositories in one column, never side by side", async () => {
    await render([TORRE_LABS]);
    await choose("torre-labs", "Select repositories");

    expect(repoCheckboxes()).toEqual(["torre-labs/heda", "torre-labs/vader"]);
    expect(container.innerHTML).not.toContain("grid-cols");
  });
});
