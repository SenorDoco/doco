// Shared grant model for the collaborators and API-tokens pages
// (decision_per_type_write_grants). Both pages grant access the same way:
// pick an organization, drill into one of its Docos (or the org itself),
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

/** Access level a grant confers, before per-type narrowing. */
export type GrantLevel = "reader" | "writer" | "owner";

/**
 * A target the current user can grant into: an organization, or a Doco
 * within one. `orgId` ties a Doco back to its organization so the picker
 * can group Docos under the org the user selected first. `maxRole` caps
 * what the user may grant here (their own role on the target).
 */
export interface GrantTarget {
  level: "org" | "doco";
  id: string;
  /** Owning organization id for a doco target; the org's own id for an org target. */
  orgId: string;
  label: string;
  maxRole: DocoRole;
}

/** The picker's catalog: every grantable target, plus org display labels. */
export interface GrantCatalog {
  orgs: { id: string; label: string }[];
  targets: GrantTarget[];
}

/**
 * The four scope levels the grant wizard offers, in breadth order. The
 * first wizard question picks one of these; the flow then adapts:
 *   - account: grant on the grantor's whole account (every org they own).
 *   - org:     grant on one organization (and its Docos).
 *   - doco:    grant role on one Doco.
 *   - types:   grant write on specific node/edge types within one Doco.
 */
export type GrantScope = "account" | "org" | "doco" | "types";

/**
 * A grant the user is composing or has saved. `writeTypes` is meaningful
 * only when `role` permits write: owner writes everything (write_types
 * ignored); a reader with a non-empty write_types set is the per-type
 * "editor"; the wildcard means write-all (a classic writer).
 *
 * `level` is the persistence level: "account" writes account_grants;
 * "org" writes org_users; "doco" writes doco_users. The wizard's "types"
 * scope persists as a doco-level grant with a non-wildcard write set.
 * `targetId` is empty for account-level grants (the grantor IS the
 * scope).
 */
export interface ComposedGrant {
  level: "account" | "org" | "doco";
  targetId: string;
  role: DocoRole;
  writeTypes: string[];
}

/**
 * Build a GrantCatalog from the invite/scope option lists both pages
 * already load: org options ({id,label,maxRole}) and doco options
 * (same plus `orgId` linking each doco to its org). Docos whose org
 * isn't in the org list (e.g. personally-owned) are grouped under a
 * synthetic "Other" bucket keyed by their ownerId so they remain
 * grantable.
 */
export function catalogFromOptions(
  orgs: { id: string; label: string; maxRole: DocoRole }[],
  docos: { id: string; label: string; maxRole: DocoRole; orgId?: string }[],
): GrantCatalog {
  const orgEntries = orgs.map((o) => ({ id: o.id, label: o.label }));
  const knownOrgIds = new Set(orgEntries.map((o) => o.id));
  const targets: GrantTarget[] = [];

  for (const o of orgs) {
    targets.push({ level: "org", id: o.id, orgId: o.id, label: o.label, maxRole: o.maxRole });
  }
  for (const d of docos) {
    const orgId = d.orgId ?? "__other__";
    targets.push({ level: "doco", id: d.id, orgId, label: d.label, maxRole: d.maxRole });
    if (orgId === "__other__" && !knownOrgIds.has("__other__")) {
      orgEntries.push({ id: "__other__", label: "Personal / other" });
      knownOrgIds.add("__other__");
    }
  }
  return { orgs: orgEntries, targets };
}

/** Group the catalog's targets by organization for the drill-down UI. */
export function targetsByOrg(catalog: GrantCatalog): {
  org: { id: string; label: string };
  orgTarget: GrantTarget | null;
  docos: GrantTarget[];
}[] {
  return catalog.orgs.map((org) => {
    const inOrg = catalog.targets.filter((t) => t.orgId === org.id);
    return {
      org,
      orgTarget: inOrg.find((t) => t.level === "org") ?? null,
      docos: inOrg.filter((t) => t.level === "doco").sort((a, b) => a.label.localeCompare(b.label)),
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

/** True when the type token is one the picker can offer. */
export function isOfferableType(t: string): t is WritableType {
  return (
    (NODE_TYPES as readonly string[]).includes(t) || (EDGE_TYPES as readonly string[]).includes(t)
  );
}

/** Display metadata for each wizard scope choice. */
export interface ScopeChoice {
  scope: GrantScope;
  title: string;
  blurb: string;
}

/**
 * Which scope choices the wizard should offer, given what the granting
 * user can reach. "My entire account" only makes sense if the user OWNS
 * at least one org (an account grant cascades through owned orgs); org
 * and doco/types require at least one grantable target of that kind.
 */
export function availableScopes(catalog: GrantCatalog): ScopeChoice[] {
  const ownsAnOrg = catalog.targets.some((t) => t.level === "org" && t.maxRole === "owner");
  const hasOrg = catalog.targets.some((t) => t.level === "org");
  const hasDoco = catalog.targets.some((t) => t.level === "doco");
  const out: ScopeChoice[] = [];
  if (ownsAnOrg) {
    out.push({
      scope: "account",
      title: "My entire account",
      blurb: "Every organization you own, and every doco under them — now and in the future.",
    });
  }
  if (hasOrg) {
    out.push({
      scope: "org",
      title: "A specific organization",
      blurb: "One organization and all of its docos.",
    });
  }
  if (hasDoco) {
    out.push({
      scope: "doco",
      title: "A specific doco",
      blurb: "Read, write, or own a single doco.",
    });
    out.push({
      scope: "types",
      title: "Specific node or edge types",
      blurb: "Write access to only certain node and edge types within one doco.",
    });
  }
  return out;
}

/** A grant the grantee/token already holds, for the "current access" panel. */
export interface ExistingGrant {
  level: "account" | "org" | "doco";
  label: string;
  role: DocoRole;
  writeTypes: string[];
}

/** One-line summary of an existing grant for the current-access panel. */
export function describeExistingGrant(g: ExistingGrant): string {
  const scopeWord = g.level === "account" ? "Entire account" : g.level === "org" ? "Org" : "Doco";
  return `${scopeWord}: ${g.label} — ${describeWriteScope(g.role, g.writeTypes)}`;
}
