// Shared presentation for a single policy — the kind label plus either the
// structured deterministic breakdown or the agent instruction prose. Used by
// the policies list (`/<handle>/policies`) and the standalone Policy page
// (`/<handle>/policies/<id>`) so the two render a policy identically.

import {
  POLICY_KIND_LABEL,
  type PolicyPredicate,
  agentInstructionOf,
  deterministicHeadline,
  deterministicParts,
  isDeterministicPredicate,
  isEdgePredicate,
} from "@doco/shared";
import { LinkedProse } from "~/components/linked-text";

export type PolicyKind = "suggestion" | "deterministic" | "probabilistic";

/** The raw policy row as it comes off the `policies` table. */
export interface PolicyRowData {
  id: string;
  kind: string | null;
  lifecycle: string | null;
  created_at: Date | string | null;
  data: Record<string, unknown> | null;
}

/** A policy shaped for rendering. */
export interface PolicyItem {
  id: string;
  kind: PolicyKind;
  predicate: PolicyPredicate | null;
  /**
   * The lifecycle stages this policy fires on (`fires_when_node_lifecycle`).
   * `null`/absent means it fires regardless of lifecycle, so there's nothing
   * to surface.
   */
  firesWhenNodeLifecycle?: string[] | null;
  lifecycle: string | null;
  createdAt: string | null;
}

export function PolicyView({ item }: { item: PolicyItem }) {
  const predicate = item.predicate;
  // An empty / absent `fires_when_node_lifecycle` means the policy fires
  // regardless of lifecycle, so there's nothing to surface. When it IS scoped,
  // show the stages — otherwise editing that filter (e.g. removing "drafting")
  // leaves the card unchanged and the edit looks like it never saved.
  const firesOn = (item.firesWhenNodeLifecycle ?? []).filter((s) => typeof s === "string" && s);
  // Rendered as just another labeled row (`fires on lifecycle` → stages),
  // identical to the deterministic predicate parts — there's nothing special
  // about it.
  const firesRow =
    firesOn.length > 0 ? (
      <div className="contents">
        <dt className="text-muted-foreground">fires on lifecycle</dt>
        <dd className="font-mono text-foreground">{firesOn.join(", ")}</dd>
      </div>
    ) : null;
  return (
    <div className="min-w-0 space-y-1.5">
      <span className="neu-surface inline-block rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {POLICY_KIND_LABEL[item.kind]}
      </span>
      {predicate && isDeterministicPredicate(predicate) ? (
        <div className="space-y-1">
          <p className="text-sm font-semibold leading-6">{deterministicHeadline(predicate)}</p>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
            {deterministicParts(predicate).map((part) => (
              <div key={part.label} className="contents">
                <dt className="text-muted-foreground">{part.label}</dt>
                <dd className="font-mono text-foreground">{part.value}</dd>
              </div>
            ))}
            {firesRow}
          </dl>
        </div>
      ) : (
        <div className="space-y-0.5">
          {predicate && isEdgePredicate(predicate) ? (
            <p className="text-[10px] font-mono text-muted-foreground">
              edge-scoped: {predicate.from_node_type ?? "any"} —{predicate.edge_type}
              {predicate.edge_role ? `[${predicate.edge_role}]` : ""}→{" "}
              {predicate.to_node_type ?? "any"}
            </p>
          ) : null}
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Agent instruction:
          </p>
          <p className="whitespace-pre-wrap break-words text-sm leading-6">
            {predicate ? <LinkedProse text={agentInstructionOf(predicate) ?? ""} /> : null}
          </p>
          {firesRow ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
              {firesRow}
            </dl>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function toPolicyItem(row: PolicyRowData): PolicyItem {
  const data = row.data ?? {};
  const kind: PolicyKind =
    row.kind === "deterministic" || row.kind === "probabilistic"
      ? row.kind
      : data.kind === "deterministic" || data.kind === "probabilistic"
        ? data.kind
        : "suggestion";
  const predicate =
    data.predicate && typeof data.predicate === "object"
      ? (data.predicate as PolicyPredicate)
      : null;
  const firesWhenNodeLifecycle = Array.isArray(data.fires_when_node_lifecycle)
    ? data.fires_when_node_lifecycle.filter((v): v is string => typeof v === "string")
    : null;
  return {
    id: row.id,
    kind,
    predicate,
    firesWhenNodeLifecycle,
    lifecycle: row.lifecycle,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
