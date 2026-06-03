// Shared chrome for the three Integrations pages (account, workspace, Doco):
//   - `ScopeNavLinks` renders the "View workspace-wide / account-wide" jump links
//     above the panes; which ones appear depends on the current page scope.
//   - `AvailableIntegrations` renders the right-pane catalog of every
//     integration we offer, with a "Connect" / "Set up..." action that
//     either runs the install directly or jumps to the picker for the
//     correct workspace/Doco.
//   - `ScopePickerBanner` shows the "pick a target" prompt that appears at
//     the top of a scope page when the user clicked through from a higher
//     scope (e.g. picked GitHub on the account page → shown a Doco prompt).
import {
  ArrowDown,
  ArrowUpRight,
  Building2,
  type LucideIcon,
  Plug,
  Trash2,
  User,
} from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link } from "react-router";
import { Card, CardContent } from "~/components/card";
import { cn } from "~/lib/cn";
import {
  INTEGRATION_CATALOG,
  type IntegrationDefinition,
  type IntegrationScope,
  connectHrefFor,
  findIntegration,
} from "~/lib/integrations-catalog";

// One source of truth for the small pill action that ends every integrations
// row. Secondary (outline) backs the "Manage" / "Set defaults" actions on the
// connected pane and the scope-nav links; primary backs the catalog's
// "Connect" / "Set up…". Keeping them here means every action button across the
// three integrations pages is the exact same size, weight, and shape.
export const CONNECTION_ACTION_SECONDARY =
  "neu-button inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:text-primary";
export const CONNECTION_ACTION_PRIMARY =
  "neu-button inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90";
// Same pill geometry as the secondary action, in the destructive tint — for a
// row's "Remove"/"Disconnect" control so it lines up with "Set defaults".
export const CONNECTION_ACTION_DESTRUCTIVE =
  "neu-button inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-destructive hover:bg-input";

export interface ConnectionAction {
  label: string;
  /** Client-side route to the manage/configure screen for this connection. */
  href: string;
  /** Optional trailing glyph (e.g. ArrowRight to "go manage"). */
  icon?: LucideIcon;
}

/**
 * The flush divider list that holds connection rows. Drop it straight into a
 * `<CardContent className="p-0">` so the rows sit edge-to-edge under the card
 * header — the same chrome the per-workspace and per-Doco rollups already use.
 */
export function ConnectionList({ children }: { children: ReactNode }) {
  return <ul className="divide-y divide-border">{children}</ul>;
}

/**
 * One connected resource, rendered identically wherever it appears (a Slack
 * workspace install, a workspace in the account rollup, a Doco in a
 * workspace's rollup): an identity on the left — a `title` that optionally
 * links to its own manage page, plus a muted `detail` status line — and a
 * single standardized action on the right, with room for an optional
 * `secondaryAction` (e.g. a destructive "Remove" form button) beside it.
 * `children` hangs extra content (e.g. a nested per-Doco sub-list) beneath the
 * row.
 */
export function ConnectionRow({
  title,
  titleHref,
  detail,
  action,
  secondaryAction,
  children,
}: {
  title: ReactNode;
  titleHref?: string;
  detail?: ReactNode;
  action?: ConnectionAction;
  secondaryAction?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          {titleHref ? (
            <Link
              to={titleHref}
              className="text-sm font-semibold text-foreground hover:text-primary"
            >
              {title}
            </Link>
          ) : (
            <span className="block text-sm font-semibold text-foreground">{title}</span>
          )}
          {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        {action || secondaryAction ? (
          <div className="flex flex-wrap items-center gap-2">
            {action ? <ConnectionActionButton action={action} /> : null}
            {secondaryAction}
          </div>
        ) : null}
      </div>
      {children}
    </li>
  );
}

function ConnectionActionButton({ action }: { action: ConnectionAction }) {
  const { label, href, icon: Icon } = action;
  return (
    <Link to={href} className={CONNECTION_ACTION_SECONDARY}>
      {label}
      {Icon ? <Icon className="h-3.5 w-3.5" aria-hidden="true" /> : null}
    </Link>
  );
}

/**
 * The destructive "Remove" control for a Slack install, used as a row's
 * `secondaryAction`. Slack removal is the same operation from anywhere it's
 * shown — the per-workspace management card or the account-level "not linked"
 * fallback — so the form always posts the `remove_slack` intent to the
 * canonical `/integrations` action (which owner-gates bound teams server-side),
 * regardless of which page rendered it. A confirm() guards the irreversible
 * delete before the post.
 */
export function RemoveSlackButton({
  teamId,
  teamName,
}: {
  teamId: string;
  teamName: string;
}) {
  return (
    <Form method="post" action="/integrations">
      <input type="hidden" name="intent" value="remove_slack" />
      <input type="hidden" name="workspace_id" value={teamId} />
      <button
        type="submit"
        onClick={(event) => {
          if (
            !confirm(
              `Remove Señor Doco from ${teamName}? This deletes its channel defaults and personal links, and can't be undone.`,
            )
          ) {
            event.preventDefault();
          }
        }}
        className={CONNECTION_ACTION_DESTRUCTIVE}
      >
        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        Remove
      </button>
    </Form>
  );
}

export function ScopeNavLinks({
  scope,
  workspaceHandle,
}: {
  scope: IntegrationScope;
  workspaceHandle?: string;
}) {
  if (scope === "account") return null;
  const linkClass = CONNECTION_ACTION_SECONDARY;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {scope === "doco" && workspaceHandle ? (
        <Link to={`/workspaces/${workspaceHandle}/integrations`} className={linkClass}>
          <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
          View workspace-wide integrations
        </Link>
      ) : null}
      <Link to="/integrations" className={linkClass}>
        <User className="h-3.5 w-3.5" aria-hidden="true" />
        View account-wide integrations
      </Link>
    </div>
  );
}

export function AvailableIntegrations({
  pageScope,
  workspaceHandle,
  docoHandle,
  docoInstallUrl,
}: {
  pageScope: IntegrationScope;
  workspaceHandle?: string;
  docoHandle?: string;
  docoInstallUrl?: string | null;
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <ul className="divide-y divide-border">
          {INTEGRATION_CATALOG.map((integration) => (
            <AvailableIntegrationRow
              key={integration.id}
              integration={integration}
              pageScope={pageScope}
              workspaceHandle={workspaceHandle}
              docoHandle={docoHandle}
              docoInstallUrl={docoInstallUrl}
            />
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function AvailableIntegrationRow({
  integration,
  pageScope,
  workspaceHandle,
  docoHandle,
  docoInstallUrl,
}: {
  integration: IntegrationDefinition;
  pageScope: IntegrationScope;
  workspaceHandle?: string;
  docoHandle?: string;
  docoInstallUrl?: string | null;
}) {
  const href = connectHrefFor({
    integration,
    pageScope,
    ...(workspaceHandle ? { workspaceHandle } : {}),
    ...(docoHandle ? { docoHandle } : {}),
    ...(docoInstallUrl !== undefined ? { docoInstallUrl } : {}),
  });
  const external = href.startsWith("http");
  const scopeLabel = scopeLabelFor(integration.scope);
  const sameScope = integration.scope === pageScope;
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 p-4">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-primary" aria-hidden="true" />
          <span className="text-sm font-semibold text-foreground">{integration.name}</span>
          <span
            className={cn(
              "rounded-full border px-2 py-[1px] text-[10px] font-semibold uppercase tracking-wide",
              sameScope ? "border-primary/40 text-primary" : "border-border text-muted-foreground",
            )}
          >
            {scopeLabel}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{integration.description}</p>
      </div>
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
        className={CONNECTION_ACTION_PRIMARY}
      >
        {sameScope ? "Connect" : "Set up..."}
        <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </li>
  );
}

function scopeLabelFor(scope: IntegrationScope): string {
  if (scope === "account") return "Account-wide";
  if (scope === "workspace") return "Workspace-level";
  return "Doco-level";
}

/**
 * Shown at the top of the account or workspace integrations page when the URL
 * carries an `?integration=<id>` hint — meaning the user got here from a
 * higher-scope "Connect" click and still needs to point at the workspace/Doco
 * to install into. The accompanying rollup card below is highlighted by
 * scrolling to the `#pick-doco` or `#pick-workspace` anchor.
 */
export function ScopePickerBanner({
  integrationId,
  pageScope,
  workspaceHandle,
}: {
  integrationId: string | null;
  pageScope: IntegrationScope;
  workspaceHandle?: string;
}) {
  if (!integrationId) return null;
  const integration = findIntegration(integrationId);
  if (!integration) return null;
  if (integration.scope === pageScope) return null;

  const targetWord = integration.scope === "doco" ? "Doco" : "workspace";
  const anchorHref =
    integration.scope === "doco"
      ? pageScope === "workspace" && workspaceHandle
        ? `/workspaces/${workspaceHandle}/integrations#pick-doco`
        : "/integrations#pick-doco"
      : "/integrations#pick-workspace";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-primary/40 bg-primary/5 p-4 text-sm">
      <div className="flex items-center gap-3">
        <Plug className="h-5 w-5 text-primary" aria-hidden="true" />
        <div>
          <p className="font-semibold text-foreground">
            Pick a {targetWord} to set up {integration.name}
          </p>
          <p className="text-xs text-muted-foreground">
            {integration.name} is configured at the {targetWord} level — choose which {targetWord}{" "}
            from the list below to continue.
          </p>
        </div>
      </div>
      <a
        href={anchorHref}
        className="neu-button inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground"
      >
        Jump to {targetWord} list
        <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
      </a>
    </div>
  );
}
