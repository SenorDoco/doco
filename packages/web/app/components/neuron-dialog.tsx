import { Loader2, X } from "lucide-react";
import { NeuronTypeIcon } from "~/components/neuron-type-icon";
import { lifecycleColor } from "~/lib/neuron-colors";
import type { LifecycleStage, NeuronDialogDetail } from "~/lib/neuron-detail.server";

// Per-entity-type prose-field-name lookup. Migrated neurons carry
// their full prose under a key matching the entity type (intent,
// decision, ...); non-migrated entities (principals, policies) still
// use the legacy summary/body_md pair. The dialog uses this to label
// the prose section heading appropriately.
const PROSE_FIELD_NAME: Record<string, string> = {
  intent: "intent",
  decision: "decision",
  rule: "rule",
  action: "action",
  log: "log",
  eval: "eval",
  reference: "reference",
  state: "state",
  idea: "idea",
};

function proseFieldName(entityType: string | undefined): string {
  if (!entityType) return "summary";
  return PROSE_FIELD_NAME[entityType] ?? "summary";
}

interface NeuronDialogProps {
  detail: NeuronDialogDetail | null;
  loading: boolean;
  error: string | null;
  lifecycleUpdating: LifecycleStage | null;
  lifecycleError: string | null;
  onClose: () => void;
  onLifecycleChange: (stage: LifecycleStage) => void;
  onOpenNeuron: (entityType: string, id: string, href: string) => void;
}

function displayDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function lifecycleButtonClass(detail: NeuronDialogDetail, stage: LifecycleStage, active: boolean) {
  const base =
    "inline-flex h-8 min-w-0 items-center justify-center rounded-md border border-border px-3 text-[11px] font-semibold capitalize";
  if (active) {
    return `${base} neu-pressed`;
  }
  const option = detail.lifecycle_options.find((candidate) => candidate.value === stage);
  if (option?.disabled) {
    return `${base} neu-button cursor-not-allowed opacity-55`;
  }
  return `${base} neu-button`;
}

export function NeuronDialog({
  detail,
  loading,
  error,
  lifecycleUpdating,
  lifecycleError,
  onClose,
  onLifecycleChange,
  onOpenNeuron,
}: NeuronDialogProps) {
  const title = detail?.name ?? detail?.summary ?? detail?.id ?? "Neuron";
  const disabledReason = detail?.lifecycle_options.find(
    (option) => option.disabled && !option.current,
  )?.reason;
  // Migrated neurons carry their full prose in a single type-named
  // field; for those we render the prose as a card at the top of the
  // content area and skip both the truncated h2 title and the separate
  // "body" section heading — otherwise the first line shows twice
  // (once as the title, once as the start of the prose) and the type
  // label appears twice (once as the chip, once as the section
  // heading). Non-migrated entities (principals, policies) still
  // have a distinct short name + long body, so they keep the legacy
  // title + body-section rendering.
  const isMigratedNeuron = Boolean(detail && PROSE_FIELD_NAME[detail.entity_type]);

  return (
    <aside
      className="neu-floating relative z-30 flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-card"
      aria-label="Neuron details"
    >
      <header className="px-4 py-3">
        <div className="flex items-start gap-3">
          {detail ? (
            <NeuronTypeIcon entityType={detail.entity_type} className="mt-0.5 !h-4 !w-4 shrink-0" />
          ) : null}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase text-muted-foreground">
                  {detail?.entity_type ?? "Neuron"}
                </p>
                {isMigratedNeuron ? null : (
                  <h2 className="mt-0.5 break-words text-sm font-semibold leading-snug text-foreground">
                    {title}
                  </h2>
                )}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="neu-button inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
                aria-label="Close neuron details"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {detail ? (
              <div className="mt-3 space-y-2">
                <div className="flex flex-wrap gap-1.5" aria-label="Lifecycle stages">
                  {detail.lifecycle_options.map((option) => {
                    const color = lifecycleColor(option.value);
                    const busy = lifecycleUpdating === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        disabled={option.disabled || busy || lifecycleUpdating !== null}
                        onClick={() => onLifecycleChange(option.value)}
                        title={option.reason ?? `Mark as ${option.value}`}
                        className={lifecycleButtonClass(detail, option.value, option.current)}
                        style={{ color }}
                      >
                        {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                {disabledReason ? (
                  <p className="text-[11px] leading-snug text-muted-foreground">{disabledReason}</p>
                ) : null}
                {lifecycleError ? (
                  <p className="text-[11px] leading-snug text-destructive">{lifecycleError}</p>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div
        className="neuron-dialog-scroll min-h-0 flex-1 overflow-y-scroll px-4 pb-8 pt-4"
        style={{ scrollbarGutter: "stable" }}
      >
        {loading ? (
          <div className="flex min-h-40 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Loading neuron...
          </div>
        ) : null}
        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {detail && !loading ? (
          <div className="space-y-5 text-xs">
            {isMigratedNeuron && detail.body_md ? (
              <section>
                <div className="whitespace-pre-wrap break-words text-sm font-bold leading-6 text-foreground">
                  {detail.body_md}
                </div>
              </section>
            ) : null}

            <section>
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">Id</dt>
                <dd className="break-all font-mono">{detail.id}</dd>
                <dt className="text-muted-foreground">Lifecycle</dt>
                <dd className="font-mono" style={{ color: lifecycleColor(detail.lifecycle) }}>
                  {detail.lifecycle}
                </dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{displayDate(detail.created_at)}</dd>
                <dt className="text-muted-foreground">Updated</dt>
                <dd>{displayDate(detail.updated_at)}</dd>
                <dt className="text-muted-foreground">Role</dt>
                <dd>{detail.user_role ?? "none"}</dd>
              </dl>
            </section>

            {!isMigratedNeuron && detail.body_md ? (
              <section className="pt-4">
                <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                  {proseFieldName(detail.entity_type)}
                </h3>
                <div className="whitespace-pre-wrap break-words leading-5">{detail.body_md}</div>
              </section>
            ) : null}

            <section className="pt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                Synapses
              </h3>
              <div className="space-y-4">
                <EdgeList label="Outgoing" edges={detail.outgoing} onOpenNeuron={onOpenNeuron} />
                <EdgeList
                  label="Referenced by"
                  edges={detail.incoming}
                  onOpenNeuron={onOpenNeuron}
                />
              </div>
            </section>

            <section className="pt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                Lifecycle History
              </h3>
              {detail.lifecycle_history.length === 0 ? (
                <p className="text-muted-foreground">No lifecycle transitions recorded.</p>
              ) : (
                <ol className="space-y-2">
                  {detail.lifecycle_history.map((entry, index) => (
                    <li
                      key={`${entry.at}-${index}`}
                      className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3"
                    >
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {displayDate(entry.at)}
                      </span>
                      <span className="font-mono">
                        {entry.from ?? "(initial)"} {"->"} {entry.to}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="pt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                History
              </h3>
              {detail.history.length === 0 ? (
                <p className="text-muted-foreground">No audit events yet.</p>
              ) : (
                <ol className="space-y-3">
                  {detail.history.map((event) => (
                    <li key={event.event_id} className="border-l-2 border-border pl-3">
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {displayDate(event.at)} · {event.by ?? "anonymous"} ·{" "}
                        <span className="text-foreground">{event.op}</span>
                      </div>
                      {event.before || event.after ? (
                        <pre className="neu-inset mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words bg-card p-2 text-[11px] leading-snug">
                          {JSON.stringify({ before: event.before, after: event.after }, null, 2)}
                        </pre>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className="pt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                Metadata
              </h3>
              <dl className="divide-y divide-border">
                {Object.entries(detail.frontmatter).map(([key, value]) => (
                  <div key={key} className="grid gap-2 py-2 md:grid-cols-[8rem_minmax(0,1fr)]">
                    <dt className="font-mono text-muted-foreground">{key}</dt>
                    <dd className="min-w-0">
                      <code className="block whitespace-pre-wrap break-words font-mono text-[11px]">
                        {formatValue(value)}
                      </code>
                    </dd>
                  </div>
                ))}
              </dl>
              <details className="pt-3">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                  Raw JSON
                </summary>
                <pre className="neu-inset mt-2 overflow-auto bg-card p-3 text-[11px] leading-snug">
                  {detail.raw_json}
                </pre>
              </details>
            </section>
          </div>
        ) : null}
      </div>
      {/* Bottom fade — tells the user content extends below the visible
          area even when the OS auto-hides the scrollbar. pointer-events
          off so it doesn't swallow clicks on the last row of content. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-lg bg-gradient-to-t from-card to-transparent"
      />
    </aside>
  );
}

function EdgeList({
  label,
  edges,
  onOpenNeuron,
}: {
  label: string;
  edges: NeuronDialogDetail["outgoing"];
  onOpenNeuron: (entityType: string, id: string, href: string) => void;
}) {
  return (
    <div>
      <h4 className="mb-1.5 text-[11px] font-medium text-muted-foreground">
        {label} ({edges.length})
      </h4>
      {edges.length === 0 ? (
        <p className="text-muted-foreground">None.</p>
      ) : (
        <ul className="neu-surface divide-y divide-border">
          {edges.map((edge) => {
            const edgeTitle = edge.other_name ?? edge.other_summary ?? edge.other_id;
            return (
              <li key={`${label}-${edge.synapse_type}-${edge.other_id}`}>
                <button
                  type="button"
                  className="block w-full px-3 py-2 text-left"
                  onClick={() =>
                    onOpenNeuron(
                      edge.other_neuron_type,
                      edge.other_id,
                      edge.href ?? `/${edge.other_neuron_type}/${edge.other_id}`,
                    )
                  }
                >
                  <div className="flex flex-wrap items-center gap-1.5 text-[10px] uppercase text-muted-foreground">
                    <NeuronTypeIcon entityType={edge.other_neuron_type} className="!h-3 !w-3" />
                    <span>{edge.other_neuron_type}</span>
                    <span className="font-mono normal-case">{edge.synapse_type}</span>
                  </div>
                  <p className="mt-0.5 break-words text-xs text-foreground">{edgeTitle}</p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
