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
  lifecycle: string | null;
  createdAt: string | null;
}

export function PolicyView({ item }: { item: PolicyItem }) {
  const predicate = item.predicate;
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
  return {
    id: row.id,
    kind,
    predicate,
    lifecycle: row.lifecycle,
    createdAt: toIso(row.created_at),
  };
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
