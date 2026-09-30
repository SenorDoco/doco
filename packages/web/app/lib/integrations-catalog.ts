// Catalog of available integrations and the scope each one is configured at.
//
// The catalog drives the right-pane "available integrations" list. When a
// Doco-level integration is set up from a workspace or the account page, its
// button opens its own setup page when it has one (GitHub asks what to bring
// and fills a Doco per choice), or else a picker that asks which Doco to set
// it up on.

export type IntegrationScope = "account" | "workspace" | "doco";

export interface IntegrationDefinition {
  id: string;
  name: string;
  description: string;
  scope: IntegrationScope;
  /** The integration's own setup page, which picks its Docos itself; without
   *  one, a Doco-level integration is set up from a Doco picker. */
  setupPath?: string;
}

export const INTEGRATION_CATALOG: readonly IntegrationDefinition[] = [
  {
    id: "slack",
    name: "Slack",
    description:
      "Connect a Slack team to one doco workspace. Señor Doco then works only in that workspace's docos; individual channels can be wired to specific docos after install.",
    scope: "workspace",
  },
  {
    id: "github",
    name: "GitHub",
    description:
      "Bring pull requests and bugs from GitHub repositories into a workspace, each into its own doco.",
    scope: "doco",
    setupPath: "/integrations/github",
  },
  {
    id: "notion",
    name: "Notion",
    description:
      "Mirror the Notion pages and databases you share with Doco into one doco, kept in sync, so they can be searched alongside its knowledge.",
    scope: "doco",
  },
];

export function findIntegration(id: string): IntegrationDefinition | undefined {
  return INTEGRATION_CATALOG.find((i) => i.id === id);
}

/**
 * Where an integration's "Connect" / "Set up..." button goes. Slack runs its
 * own install flow, which picks the workspace itself. A Doco-level integration
 * goes to the Doco's own setup page; from a workspace or the account page,
 * which have no one Doco to set it up on, it opens its own setup page (for
 * that workspace), or else that page's Doco picker (`?integration=<id>`).
 */
export function connectHrefFor(opts: {
  integration: IntegrationDefinition;
  workspaceHandle?: string;
  docoHandle?: string;
}): string {
  const { integration, workspaceHandle, docoHandle } = opts;
  if (integration.id === "slack") return "/integrations/slack/install";
  if (docoHandle) return `/${docoHandle}/integrations/${integration.id}`;
  if (integration.setupPath) {
    return workspaceHandle
      ? `${integration.setupPath}?${new URLSearchParams({ workspace: workspaceHandle })}`
      : integration.setupPath;
  }
  const query = new URLSearchParams({ integration: integration.id }).toString();
  if (workspaceHandle) return `/workspaces/${workspaceHandle}/integrations?${query}`;
  return `/integrations?${query}`;
}
