// Catalog of available integrations and the scope each one is configured at.
//
// The catalog drives both the right-pane "available integrations" list and the
// scope-prompt logic — when an integration's `scope` doesn't match the page
// you're viewing it from, the action button routes to a picker that asks which
// workspace or Doco to install into.

export type IntegrationScope = "account" | "workspace" | "doco";

export interface IntegrationDefinition {
  id: string;
  name: string;
  description: string;
  scope: IntegrationScope;
}

export const INTEGRATION_CATALOG: readonly IntegrationDefinition[] = [
  {
    id: "slack",
    name: "Slack",
    description:
      "Install Señor Doco into a Slack workspace. Channels can be wired to an workspace or Doco after the workspace install.",
    scope: "account",
  },
  {
    id: "github",
    name: "GitHub",
    description: "Connect repositories so their pull requests are tracked as References on a Doco.",
    scope: "doco",
  },
];

export function findIntegration(id: string): IntegrationDefinition | undefined {
  return INTEGRATION_CATALOG.find((i) => i.id === id);
}

/**
 * Pure decision: from which page is the user clicking, and is the
 * integration's home scope something they need to be prompted to pick?
 */
export function needsScopePrompt(opts: {
  integration: IntegrationDefinition;
  pageScope: IntegrationScope;
}): boolean {
  return opts.integration.scope !== opts.pageScope && opts.integration.scope !== "account";
}

/**
 * Resolve the link target the "Connect" button on the right pane should use.
 * Returns either:
 *  - a direct install path/URL (when the page scope already matches the
 *    integration's home scope), or
 *  - a picker path that prompts the user to choose an workspace/Doco to install
 *    into (when scopes differ).
 *
 * GitHub's terminal install URL is the GitHub App install page itself, which
 * needs the Doco id as `state`. The pickers handle that handoff — they're the
 * scope-binding step, not this helper.
 */
export function connectHrefFor(opts: {
  integration: IntegrationDefinition;
  pageScope: IntegrationScope;
  workspaceHandle?: string;
  docoHandle?: string;
  docoInstallUrl?: string | null;
}): string {
  const { integration, pageScope, workspaceHandle, docoHandle, docoInstallUrl } = opts;

  if (integration.scope === "account") {
    if (integration.id === "slack") return "/integrations/slack/install";
    return "/integrations";
  }

  if (integration.scope === "doco") {
    if (pageScope === "doco" && docoHandle) {
      if (integration.id === "github") return `/${docoHandle}/integrations/github`;
      return `/${docoHandle}/integrations`;
    }
    // Cross-scope from account/workspace → pick a Doco.
    const params = new URLSearchParams({ integration: integration.id });
    if (pageScope === "workspace" && workspaceHandle) {
      return `/workspaces/${workspaceHandle}/integrations?${params.toString()}#pick-doco`;
    }
    return `/integrations?${params.toString()}#pick-doco`;
  }

  if (integration.scope === "workspace") {
    if (pageScope === "workspace" && workspaceHandle)
      return `/workspaces/${workspaceHandle}/integrations`;
    const params = new URLSearchParams({ integration: integration.id });
    return `/integrations?${params.toString()}#pick-workspace`;
  }

  return "/integrations";
}
