// Shared grant model for the collaborators and API-tokens pages. Both pages
// grant access the same way: pick workspaces, or drill into a workspace's
// Docos, then choose read / write / own for each. This module is the
// framework-free core: the data shapes and the pure selection/normalization
// logic, unit-tested independently of React.

import type { DocoRole } from "@doco/db";
import { WRITE_ALL, normalizeWriteTypes } from "@doco/shared";

export type { DocoRole };

/**
 * A target the current user can grant into: an workspace, or a Doco
 * within one. `workspaceId` ties a Doco back to its workspace so the picker
 * can group Docos under the workspace the user selected first. `maxRole` caps
 * what the user may grant here (their own role on the target).
 */
export interface GrantTarget {
  level: "workspace" | "doco";
  id: string;
  /** Owning workspace id for a doco target; the workspace's own id for an workspace target. */
  workspaceId: string;
  label: string;
  maxRole: DocoRole;
}

/** The picker's catalog: every grantable target, plus workspace display labels. */
export interface GrantCatalog {
  workspaces: { id: string; label: string }[];
  targets: GrantTarget[];
}

/**
 * The scope levels the grant wizard can offer, in breadth order. The
 * first wizard question picks one of these; the flow then adapts:
 *   - actor:   mint a user-level "all workspaces" TOKEN (no explicit grants; its
 *              breadth is the user's live membership).
 *   - workspace:     grant on one or more workspaces (and their Docos).
 *   - doco:    grant role on one or more Docos.
 *
 * `actor` is offered ONLY when minting a credential (`offerActor`): its breadth
 * follows the user's live membership instead of a snapshot of workspaces.
 * Granting another PERSON always names concrete targets —
 * a specific workspace or doco — never "all your workspaces" (that breadth is a
 * token-only authorization). There is no "identity" (full-access) scope anymore.
 */
export type GrantScope = "actor" | "workspace" | "doco";

/**
 * A grant the user is composing or has saved. `writeTypes` is meaningful
 * only when `role` permits write: owner writes everything (write_types
 * ignored); a reader with a non-empty write_types set is the per-type
 * "editor"; the wildcard means write-all (a classic writer).
 *
 * `level` is the persistence level: "actor" mints a user-level token (no
 * explicit grants — the server reads only the level); "workspace" writes
 * workspace_users; "doco" writes doco_users. `targetId` is empty for
 * actor-level grants (the grantor IS the scope).
 */
export interface ComposedGrant {
  level: "actor" | "workspace" | "doco";
  targetId: string;
  role: DocoRole;
  writeTypes: string[];
}

/**
 * The synthetic grant the "All your workspaces" (actor) scope emits. It has no
 * target — the server short-circuits on `level: "actor"` to mint a user-level
 * credential — and its `role` is the CEILING applied to every workspace at
 * refresh (capped by your real role there). "owner" = your full live role.
 */
export function actorGrant(role: DocoRole = "owner"): ComposedGrant {
  return { level: "actor", targetId: "", role, writeTypes: [] };
}

/**
 * Build a GrantCatalog from the invite/scope option lists both pages
 * already load: workspace options ({id,label,maxRole}) and doco options
 * (same plus `workspaceId` linking each doco to its workspace, and optional
 * `workspaceLabel` naming that workspace). Every doco gets a grouping bucket so it
 * stays grantable: personally-owned docos share a "Personal / other"
 * bucket; a doco under an workspace that isn't in the workspace list — you own the
 * Doco but not its workspace — gets its own bucket, labeled from `workspaceLabel`
 * when the caller knows the name.
 */
export function catalogFromOptions(
  workspaces: { id: string; label: string; maxRole: DocoRole }[],
  docos: {
    id: string;
    label: string;
    maxRole: DocoRole;
    workspaceId?: string;
    workspaceLabel?: string;
  }[],
): GrantCatalog {
  const workspaceEntries = workspaces.map((o) => ({ id: o.id, label: o.label }));
  const knownWorkspaceIds = new Set(workspaceEntries.map((o) => o.id));
  const targets: GrantTarget[] = [];

  for (const o of workspaces) {
    targets.push({
      level: "workspace",
      id: o.id,
      workspaceId: o.id,
      label: o.label,
      maxRole: o.maxRole,
    });
  }
  for (const d of docos) {
    const workspaceId = d.workspaceId ?? "__other__";
    targets.push({ level: "doco", id: d.id, workspaceId, label: d.label, maxRole: d.maxRole });
    // Every doco needs a grouping bucket in `workspaceEntries`, or the workspace
    // drill-down (targetsByWorkspace) silently drops it while the "Specific
    // docos" scope still counts it — the orphaning that made an
    // owner-grantable Doco under an workspace you don't own show up as "No
    // docos you can grant". Mint the missing bucket: "Personal / other"
    // for the personal sentinel, otherwise the workspace's own (from
    // `workspaceLabel` when known).
    if (!knownWorkspaceIds.has(workspaceId)) {
      workspaceEntries.push({
        id: workspaceId,
        label:
          workspaceId === "__other__"
            ? "Personal / other"
            : (d.workspaceLabel ?? "Other workspace"),
      });
      knownWorkspaceIds.add(workspaceId);
    }
  }
  return { workspaces: workspaceEntries, targets };
}

/** Group the catalog's targets by workspace for the drill-down UI. */
export function targetsByWorkspace(catalog: GrantCatalog): {
  workspace: { id: string; label: string };
  workspaceTarget: GrantTarget | null;
  docos: GrantTarget[];
}[] {
  return catalog.workspaces.map((workspace) => {
    const inWorkspace = catalog.targets.filter((t) => t.workspaceId === workspace.id);
    return {
      workspace,
      workspaceTarget: inWorkspace.find((t) => t.level === "workspace") ?? null,
      docos: inWorkspace
        .filter((t) => t.level === "doco")
        .sort((a, b) => a.label.localeCompare(b.label)),
    };
  });
}

/** The roles the user may grant on a target, capped by their own role. */
export function grantableRoles(maxRole: DocoRole): DocoRole[] {
  const order: DocoRole[] = ["reader", "writer", "owner"];
  const cap = rank(maxRole);
  return order.filter((r) => rank(r) <= cap);
}

export function rank(role: DocoRole): number {
  return role === "owner" ? 2 : role === "writer" ? 1 : 0;
}

/**
 * Resolve the effective write_types a composed grant should persist.
 *
 *   - owner               → [] (owner writes everything; no per-type set)
 *   - reader, no types    → [] (read-only)
 *   - "write everything"  → ["*"]
 *   - explicit type list  → the normalized subset
 *
 * `selected` is the raw set the UI gathered (may include "*" or junk).
 */
export function resolveWriteTypes(role: DocoRole, selected: string[]): string[] {
  if (role === "owner") return [];
  return normalizeWriteTypes(selected);
}

/** Human summary of a grant's write scope for list display. */
export function describeWriteScope(role: DocoRole, writeTypes: string[]): string {
  if (role === "owner") return "owns — writes everything";
  const norm = normalizeWriteTypes(writeTypes);
  if (norm.length === 0) return "read only";
  if (norm.includes(WRITE_ALL)) return "writes everything";
  return `writes ${norm.length} type${norm.length === 1 ? "" : "s"}`;
}

/** Display metadata for each wizard scope choice. */
export interface ScopeChoice {
  scope: GrantScope;
  title: string;
  blurb: string;
}

/**
 * Which scope choices the wizard should offer, given what the granting user
 * can reach. One opt-in breadth choice sits at the top, for TOKENS only:
 *   - the consent screens → the `actor` scope (user-level "all workspaces"),
 *     offered when the host opts in (`offerActor`),
 *     the user has ≥1 workspace to act in, and the connector isn't pinned to a
 *     single workspace (`boundWorkspaceLabel`). The /tokens page surfaces actor
 *     through its own top-level toggle instead, so it leaves `offerActor` off.
 * Granting another PERSON is always a concrete target — a specific workspace or
 * doco — so there is no "all your workspaces" choice here; that breadth is a
 * token-only authorization (`actor`). workspace and doco require at least one
 * grantable target of that kind.
 */
export function availableScopes(
  catalog: GrantCatalog,
  opts: { offerActor?: boolean; boundWorkspaceLabel?: string } = {},
): ScopeChoice[] {
  const hasWorkspace = catalog.targets.some((t) => t.level === "workspace");
  const hasDoco = catalog.targets.some((t) => t.level === "doco");
  const out: ScopeChoice[] = [];
  if (opts.offerActor && hasWorkspace && !opts.boundWorkspaceLabel) {
    out.push({
      scope: "actor",
      title: "All your workspaces",
      blurb:
        "Reaches every workspace you belong to, including ones you join later. Pick the access level it gets, capped by your own role in each workspace.",
    });
  }
  if (hasWorkspace) {
    // When the connector is bound to one workspace, the first option grants
    // that whole workspace by name (with an inline access-level dropdown);
    // otherwise it's the generic, possibly-multi-workspace choice.
    out.push(
      opts.boundWorkspaceLabel
        ? {
            scope: "workspace",
            title: `The entire ${opts.boundWorkspaceLabel} workspace`,
            blurb: "Read, write, or own the whole workspace and all of its Docos.",
          }
        : {
            scope: "workspace",
            title: "Specific workspace(s)",
            blurb: "One or more workspaces and all of their docos.",
          },
    );
  }
  if (hasDoco) {
    out.push({
      scope: "doco",
      title: "Specific docos",
      blurb: "Read, write, or own selected docos.",
    });
  }
  return out;
}

/** A grant the grantee/token already holds, for the "current access" panel. */
export interface ExistingGrant {
  level: "workspace" | "doco";
  targetId: string;
  label: string;
  role: DocoRole;
  writeTypes: string[];
}

/** One-line summary of an existing grant for the current-access panel. */
export function describeExistingGrant(g: ExistingGrant): string {
  const scopeWord = g.level === "workspace" ? "Workspace" : "Doco";
  return `${scopeWord}: ${g.label} — ${describeWriteScope(g.role, g.writeTypes)}`;
}

// ── Multi-grant selection ───────────────────────────────────────────────────
//
// The wizard accumulates a LIST of grants: a person/token can be granted
// several workspaces at once, or several docos — all in one pass. These pure
// helpers maintain that list keyed by (level, targetId) so a thin component
// just renders rows and calls them.

/** Stable key for a grant within the selection list. */
export function grantKey(level: ComposedGrant["level"], targetId: string): string {
  return `${level}:${targetId}`;
}

export function findGrant(
  list: ComposedGrant[],
  level: ComposedGrant["level"],
  targetId: string,
): ComposedGrant | undefined {
  return list.find((g) => g.level === level && g.targetId === targetId);
}

export function findExistingGrant(
  list: ExistingGrant[] | undefined,
  level: ExistingGrant["level"],
  targetId: string,
): ExistingGrant | undefined {
  return list?.find((g) => g.level === level && g.targetId === targetId);
}

/** Insert or replace a grant by its (level, targetId) key. */
export function upsertGrant(list: ComposedGrant[], g: ComposedGrant): ComposedGrant[] {
  const k = grantKey(g.level, g.targetId);
  return [...list.filter((x) => grantKey(x.level, x.targetId) !== k), g];
}

/** Remove the grant with this (level, targetId), if any. */
export function removeGrant(
  list: ComposedGrant[],
  level: ComposedGrant["level"],
  targetId: string,
): ComposedGrant[] {
  const k = grantKey(level, targetId);
  return list.filter((x) => grantKey(x.level, x.targetId) !== k);
}

/**
 * The choices a per-target ACCESS dropdown offers: "none" (not granted)
 * plus every role the granter may delegate, capped by their own role.
 */
export type TargetRoleChoice = "none" | DocoRole;

export function targetRoleOptions(maxRole: DocoRole): TargetRoleChoice[] {
  return ["none", ...grantableRoles(maxRole)];
}

/** The dropdown value for a target given the current selection. */
export function targetRoleValue(
  list: ComposedGrant[],
  level: "workspace" | "doco",
  targetId: string,
  existing?: ExistingGrant[],
): TargetRoleChoice {
  return (
    findGrant(list, level, targetId)?.role ??
    findExistingGrant(existing, level, targetId)?.role ??
    "none"
  );
}

/**
 * Apply a per-target ACCESS choice (workspace / doco multi-select rows). "none"
 * removes the grant; a role adds/updates it. A writer persists the wildcard
 * write set (writes everything); reader/owner carry no per-type set.
 */
export function applyTargetRole(
  list: ComposedGrant[],
  level: "workspace" | "doco",
  targetId: string,
  choice: TargetRoleChoice,
): ComposedGrant[] {
  if (choice === "none") return removeGrant(list, level, targetId);
  return upsertGrant(list, {
    level,
    targetId,
    role: choice,
    writeTypes: choice === "writer" ? ["*"] : [],
  });
}

/** Count of grants selected, for the submit button / summary. */
export function selectionCount(list: ComposedGrant[]): number {
  return list.length;
}
