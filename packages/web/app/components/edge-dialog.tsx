import { Loader2, X } from "lucide-react";
import { Link } from "react-router";
import { LifecycleBadge, TypeBadge } from "~/components/node-badges";
import type { EdgeDialogDetail, EdgeDialogEndpoint } from "~/lib/edge-detail.server";
import { lifecycleColor } from "~/lib/node-colors";

interface EdgeDialogProps {
  detail: EdgeDialogDetail | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onOpenNode: (entityType: string, id: string, href: string) => void;
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

function AuthoringValue({
  entry,
}: {
  entry: NonNullable<EdgeDialogDetail["authoring"]["created"]>;
}) {
  const actor = entry.user_label ?? entry.user_id;
  const actorTitle =
    entry.user_label && entry.user_id ? `${entry.user_label} (${entry.user_id})` : actor;
  return (
    <span className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
      {actor ? (
        <span
          className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1 break-words"
          title={actorTitle ?? undefined}
        >
          {entry.user_label ? <span>{entry.user_label}</span> : null}
          {entry.user_id ? <code className="font-mono text-[11px]">{entry.user_id}</code> : null}
        </span>
      ) : (
        <span className="text-muted-foreground">Unknown user</span>
      )}
      {entry.mechanism ? (
        <span className="text-muted-foreground">via {entry.mechanism}</span>
      ) : null}
    </span>
  );
}

function DocoSourceLine({ doco }: { doco: EdgeDialogDetail["doco"] | null | undefined }) {
  if (!doco) return null;
  return (
    <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
      Doco{" "}
      <Link
        to={doco.href}
        className="font-mono font-semibold text-foreground underline-offset-2 hover:text-primary hover:underline"
      >
        {doco.handle}
      </Link>
    </p>
  );
}

function EndpointRow({
  label,
  endpoint,
  onOpenNode,
}: {
  label: string;
  endpoint: EdgeDialogEndpoint;
  onOpenNode: EdgeDialogProps["onOpenNode"];
}) {
  return (
    <button
      type="button"
      className="block w-full rounded-md border border-border bg-card px-3 py-2 text-left hover:bg-input/30"
      onClick={() => onOpenNode(endpoint.entity_type, endpoint.id, endpoint.href)}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="font-semibold uppercase">{label}</span>
        <span className="inline-flex items-center gap-1">
          <TypeBadge
            entityType={endpoint.entity_type}
            lifecycle={endpoint.lifecycle}
            anchor="inline"
          />
          <LifecycleBadge lifecycle={endpoint.lifecycle} anchor="inline" />
        </span>
      </div>
      <p className="mt-1 break-words text-xs font-medium text-foreground">{endpoint.summary}</p>
      <code className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">
        {endpoint.id}
      </code>
    </button>
  );
}

export function EdgeDialog({ detail, loading, error, onClose, onOpenNode }: EdgeDialogProps) {
  const title = detail ? `${detail.from.summary} ${detail.edge_type} ${detail.to.summary}` : "Edge";
  const propsEntries = detail?.props ? Object.entries(detail.props) : [];

  return (
    <aside
      className="neu-floating relative z-30 flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-white"
      aria-label="Edge details"
    >
      <header className="px-4 py-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase text-muted-foreground">Edge</p>
            {detail ? (
              <h2 className="mt-0.5 break-words text-sm font-semibold leading-snug text-foreground">
                {title}
              </h2>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="neu-button inline-flex h-8 w-8 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Close edge details"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {detail ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <code className="rounded bg-input px-1.5 py-0.5 font-mono text-[11px]">
              {detail.edge_type}
            </code>
            <span className="font-mono" style={{ color: lifecycleColor(detail.lifecycle) }}>
              {detail.lifecycle}
            </span>
          </div>
        ) : null}
      </header>

      <div
        className="node-dialog-scroll min-h-0 flex-1 overflow-y-scroll px-4 pb-8 pt-4"
        style={{ scrollbarGutter: "stable" }}
      >
        {loading ? (
          <div className="flex min-h-40 items-center justify-center text-xs text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
            Loading edge...
          </div>
        ) : null}
        {error ? (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        {detail && !loading ? (
          <div className="space-y-5 text-xs">
            <section>
              <div className="space-y-2">
                <EndpointRow label="From" endpoint={detail.from} onOpenNode={onOpenNode} />
                <EndpointRow label="To" endpoint={detail.to} onOpenNode={onOpenNode} />
              </div>
              <DocoSourceLine doco={detail.doco} />
            </section>

            <section className="pt-4">
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2">
                <dt className="text-muted-foreground">Id</dt>
                <dd className="break-all font-mono">{detail.id}</dd>
                <dt className="text-muted-foreground">Lifecycle</dt>
                <dd className="font-mono" style={{ color: lifecycleColor(detail.lifecycle) }}>
                  {detail.lifecycle}
                </dd>
                <dt className="text-muted-foreground">Created</dt>
                <dd>{displayDate(detail.created_at)}</dd>
                {detail.authoring.created ? (
                  <>
                    <dt className="text-muted-foreground">Created by</dt>
                    <dd>
                      <AuthoringValue entry={detail.authoring.created} />
                    </dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">Updated</dt>
                <dd>{displayDate(detail.updated_at)}</dd>
                {detail.authoring.updated ? (
                  <>
                    <dt className="text-muted-foreground">Updated by</dt>
                    <dd>
                      <AuthoringValue entry={detail.authoring.updated} />
                    </dd>
                  </>
                ) : null}
              </dl>
            </section>

            {propsEntries.length > 0 ? (
              <section className="pt-4">
                <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                  Props
                </h3>
                <dl className="divide-y divide-border">
                  {propsEntries.map(([key, value]) => (
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
              </section>
            ) : null}

            <section className="pt-4">
              <h3 className="mb-2 text-[11px] font-semibold uppercase text-muted-foreground">
                History
              </h3>
              {detail.history.length === 0 ? (
                <p className="text-muted-foreground">No recorded history.</p>
              ) : (
                <ol className="space-y-3">
                  {[...detail.history].reverse().map((event) => (
                    <li key={event.version} className="border-l-2 border-border pl-3">
                      <div className="font-mono text-[11px] text-muted-foreground">
                        v{event.version} · {displayDate(event.recorded_at)} ·{" "}
                        {event.actor ?? "anonymous"}
                        {event.mechanism ? ` via ${event.mechanism}` : ""} ·{" "}
                        <span className="text-foreground">{event.op}</span>
                      </div>
                      {event.reason ? <p className="mt-1 leading-5">{event.reason}</p> : null}
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>
        ) : null}
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-8 rounded-b-lg bg-gradient-to-t from-card to-transparent"
      />
    </aside>
  );
}
