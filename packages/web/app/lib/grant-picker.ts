// Shared grant model for the collaborators and API-tokens pages
// (decision_per_type_write_grants). Both pages grant access the same way:
// pick an organization, drill into one of its Docos (or the org itself),
// then choose read / write and — for write — which node and edge
// TYPES. This module is the framework-free core: the data shapes and the
// pure selection/normalization logic, unit-tested independently of React.

import type { DocoRole } from "@doco/db";
import {
  NODE_TYPES,
  type NodeType,
  EDGE_TYPES,
  type EdgeType,
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
 * A grant the user is composing or has saved. `writeTypes` is meaningful
 * only when `role` permits write: owner writes everything (write_types
 * ignored); a reader with a non-empty write_types set is the per-type
 * "editor"; the wildcard means write-all (a classic writer).
 */
export interface ComposedGrant {
  level: "org" | "doco";
  targetId: string;
  role: DocoRole;
  writeTypes: string[];
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
    (NODE_TYPES as readonly string[]).includes(t) ||
    (EDGE_TYPES as readonly string[]).includes(t)
  );
}
