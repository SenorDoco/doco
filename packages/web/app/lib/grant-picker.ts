// Shared grant model for the collaborators and API-tokens pages
// (decision_per_type_write_grants). Both pages grant access the same way:
// pick an workspace, drill into one of its Docos (or the workspace itself),
// then choose read / write and — for write — which node and edge
// TYPES. This module is the framework-free core: the data shapes and the
// pure selection/normalization logic, unit-tested independently of React.

import type { DocoRole } from "@doco/db";
import {
  EDGE_TYPES,
  type EdgeType,
  NODE_TYPES,
  type NodeType,
  WRITE_ALL,
  type WritableType,
  normalizeWriteTypes,
} from "@doco/shared";

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
 *   - account: grant on the grantor's whole account (every workspace they own).
 *   - workspace:     grant on one workspace (and its Docos).
 *   - doco:    grant role on one Doco.
 *   - types:   grant write on specific node/edge types within one Doco.
 *
 * `account` is a USER delegation (account_grants) only — it is never offered
 * when minting a TOKEN, which is capped at a single workspace. The picker's
 * `forToken` flag drops it (see `availableScopes`). There is no "identity"
 * (full-access, follows-your-permissions) scope anymore: it minted a token
 * that reached everything the human could, which the single-workspace rule
 * forbids.
 */
export type GrantScope = "account" | "workspace" | "doco" | "types";

/**
 * A grant the user is composing or has saved. `writeTypes` is meaningful
 * only when `role` permits write: owner writes everything (write_types
 * ignored); a reader with a non-empty write_types set is the per-type
 * "editor"; the wildcard means write-all (a classic writer).
 *
 * `level` is the persistence level: "account" writes account_grants (a USER
 * delegation, never a token); "workspace" writes workspace_users; "doco"
 * writes doco_users. The wizard's "types" scope persists as a doco-level grant
 * with a non-wildcard write set. `targetId` is empty for account-level grants
 * (the grantor IS the scope).
 */
export interface ComposedGrant {
  level: "account" | "workspace" | "doco";
  targetId: string;
  role: DocoRole;
  writeTypes: string[];
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

/** All write-gateable types split for display (nodes vs edges). */
export function writableTypeGroups(): {
  nodes: readonly NodeType[];
  edges: readonly EdgeType[];
} {
  return { nodes: NODE_TYPES, edges: EDGE_TYPES };
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

// ── Per-type access levels ──────────────────────────────────────────────────
//
// Each node/edge type carries an access LEVEL, not a checkbox. The level is
// "read" or "write"; "default" means "inherit the grant's base role". The
// inherited level is what the base ACCESS role gives a type when it isn't
// overridden: a writer (or a wildcard write set) writes everything; a reader
// reads everything. Owners administer and aren't per-type-narrowed.

/** A per-type access level the dropdown can hold. */
export type TypeLevel = "default" | "read" | "write";

/**
 * The level a type INHERITS from the grant's base role + wildcard, used as
 * the "default" the dropdown shows. Writer or a wildcard write set ⇒ write;
 * otherwise read.
 */
export function inheritedTypeLevel(role: DocoRole, writeTypes: string[]): "read" | "write" {
  if (role === "owner" || role === "writer") return "write";
  if (writeTypes.includes(WRITE_ALL)) return "write";
  return "read";
}

/**
 * The CURRENT effective level for a single type, given the grant's base role
 * and explicit write set. A type named in write_types writes; the wildcard
 * writes everything; otherwise it falls to the inherited level.
 */
export function effectiveTypeLevel(
  role: DocoRole,
  writeTypes: string[],
  type: string,
): "read" | "write" {
  if (role === "owner" || role === "writer") return "write";
  if (writeTypes.includes(WRITE_ALL)) return "write";
  if (writeTypes.includes(type)) return "write";
  return "read";
}

/**
 * Compute the dropdown selection for a type: "default" when its effective
 * level equals the inherited level (no override), else the explicit level.
 */
export function typeDropdownValue(role: DocoRole, writeTypes: string[], type: string): TypeLevel {
  const eff = effectiveTypeLevel(role, writeTypes, type);
  const inh = inheritedTypeLevel(role, writeTypes);
  return eff === inh ? "default" : eff;
}

/**
 * Apply a per-type level change, returning the next explicit write set.
 * Selecting "default" drops any override; "write"/"read" set the type's
 * level explicitly. Starts from the currently-effective per-type levels so
 * a change to one type doesn't disturb the others (it expands a wildcard or
 * the inherited baseline into an explicit set when needed).
 */
export function setTypeLevel(
  role: DocoRole,
  writeTypes: string[],
  type: string,
  next: TypeLevel,
  allTypes: readonly string[],
): string[] {
  // Materialize the current effective level for every type, so we can edit
  // one without losing the rest, then re-collapse.
  const desired = new Map<string, "read" | "write">();
  for (const t of allTypes) desired.set(t, effectiveTypeLevel(role, writeTypes, t));
  const inh = inheritedTypeLevel(role, writeTypes);
  desired.set(type, next === "default" ? inh : next);

  // Re-collapse: the write set is every type whose desired level is "write".
  const writes = allTypes.filter((t) => desired.get(t) === "write");
  if (writes.length === allTypes.length) return [WRITE_ALL];
  return writes;
}

/** Display metadata for each wizard scope choice. */
export interface ScopeChoice {
  scope: GrantScope;
  title: string;
  blurb: string;
}

/**
 * Which scope choices the wizard should offer, given what the granting user
 * can reach. When `forToken` is set (minting a credential rather than granting
 * a person), the account scope is withheld: a token is capped at a single
 * workspace, so "all your workspaces and docos" is never an option. The
 * account scope otherwise appears only if the user OWNS at least one workspace
 * (an account grant cascades through owned workspaces); workspace and
 * doco/types require at least one grantable target of that kind.
 */
export function availableScopes(
  catalog: GrantCatalog,
  opts: { forToken?: boolean; boundWorkspaceLabel?: string } = {},
): ScopeChoice[] {
  const ownsAnWorkspace = catalog.targets.some(
    (t) => t.level === "workspace" && t.maxRole === "owner",
  );
  const hasWorkspace = catalog.targets.some((t) => t.level === "workspace");
  const hasDoco = catalog.targets.some((t) => t.level === "doco");
  const out: ScopeChoice[] = [];
  if (ownsAnWorkspace && !opts.forToken) {
    out.push({
      scope: "account",
      title: "All your workspaces and docos",
      blurb: "Every workspace you own, and every doco under them — now and in the future.",
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
    out.push({
      scope: "types",
      title: "Specific node or edge types",
      blurb: "Write access to only certain node and edge types within one doco.",
    });
  }
  return out;
}

/**
 * Whether a scope choice surfaces the per-node/edge-type write grid. Only the
 * dedicated "types" scope does; account / workspace / doco are role-only (read /
 * write / own), with the per-type grid reachable solely through "types".
 */
export function scopeShowsPerTypeControls(scope: GrantScope): boolean {
  return scope === "types";
}

/** A grant the grantee/token already holds, for the "current access" panel. */
export interface ExistingGrant {
  level: "account" | "workspace" | "doco";
  targetId: string;
  label: string;
  role: DocoRole;
  writeTypes: string[];
}

/** One-line summary of an existing grant for the current-access panel. */
export function describeExistingGrant(g: ExistingGrant): string {
  const scopeWord =
    g.level === "account" ? "Entire account" : g.level === "workspace" ? "Workspace" : "Doco";
  return `${scopeWord}: ${g.label} — ${describeWriteScope(g.role, g.writeTypes)}`;
}

// ── Multi-grant selection ───────────────────────────────────────────────────
//
// The wizard accumulates a LIST of grants: a person/token can be granted
// several workspaces at once, several docos, or a per-type doco grant — all in one
// pass. These pure helpers maintain that list keyed by (level, targetId) so a
// thin component just renders rows and calls them.

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

/**
 * Apply a per-TYPE level change to the doco grant for `docoId` (the "types"
 * scope). The grant is reader-based with an explicit write set; setting a
 * type to "write" adds it, "read"/"default" removes it. When the resulting
 * write set is empty the doco grant is dropped entirely (nothing to grant).
 */
export function applyDocoTypeLevel(
  list: ComposedGrant[],
  docoId: string,
  type: string,
  next: TypeLevel,
  allTypes: readonly string[],
  fallback?: { role: DocoRole; writeTypes: string[] },
): ComposedGrant[] {
  const current = findGrant(list, "doco", docoId);
  const role = current?.role ?? fallback?.role ?? "reader";
  const base = current?.writeTypes ?? fallback?.writeTypes ?? [];
  const nextTypes = setTypeLevel(role, base, type, next, allTypes);
  if (nextTypes.length === 0) return removeGrant(list, "doco", docoId);
  return upsertGrant(list, {
    level: "doco",
    targetId: docoId,
    role: "reader",
    writeTypes: nextTypes,
  });
}

/** Count of grants selected, for the submit button / summary. */
export function selectionCount(list: ComposedGrant[]): number {
  return list.length;
}

/**
 * The real workspace a composed grant belongs to, or null when it doesn't
 * count toward the one-workspace token cap. A workspace grant is its own id; a
 * Doco grant inherits its catalog target's workspace. Personal Docos (the
 * "__other__" bucket) and any non-`workspace_` bucket return null — they're
 * not a workspace, mirroring the server-side invariant.
 */
export function workspaceOfComposedGrant(g: ComposedGrant, catalog: GrantCatalog): string | null {
  if (g.level === "workspace") return g.targetId.startsWith("workspace_") ? g.targetId : null;
  if (g.level === "doco") {
    const t = catalog.targets.find((x) => x.level === "doco" && x.id === g.targetId);
    const w = t?.workspaceId;
    return w?.startsWith("workspace_") ? w : null;
  }
  return null;
}

/**
 * Enforce the single-workspace token cap on a selection change. If the next
 * selection touches more than one workspace, keep only the grants in the
 * workspace of the most-recently-added entry (Doco grants in other workspaces
 * are dropped); personal/no-workspace grants always survive. This makes the
 * token picker honest about the rule the server enforces at mint time.
 */
export function coerceSingleWorkspace(
  prev: ComposedGrant[],
  next: ComposedGrant[],
  catalog: GrantCatalog,
): ComposedGrant[] {
  const workspaces = new Set(
    next.map((g) => workspaceOfComposedGrant(g, catalog)).filter((w): w is string => w !== null),
  );
  if (workspaces.size <= 1) return next;
  const prevKeys = new Set(prev.map((g) => grantKey(g.level, g.targetId)));
  const added = next.filter((g) => !prevKeys.has(grantKey(g.level, g.targetId)));
  const keep =
    (added.length > 0 ? workspaceOfComposedGrant(added[added.length - 1], catalog) : null) ??
    workspaceOfComposedGrant(next[0], catalog);
  return next.filter((g) => {
    const w = workspaceOfComposedGrant(g, catalog);
    return w === null || w === keep;
  });
}
