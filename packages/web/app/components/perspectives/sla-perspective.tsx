import { AlertTriangle, CheckCircle2, ExternalLink, FileText, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { perspectiveCountLabel, visibleLifecycleTotal } from "~/lib/perspective-count";
import type { SlaCommitment, SlaLink, SlaPerspectiveData } from "~/lib/sla-perspective.server";

interface SlaPerspectiveProps {
  data: SlaPerspectiveData;
  visibleLifecycles?: Set<string>;
}

export function SlaPerspective({ data, visibleLifecycles }: SlaPerspectiveProps) {
  const filtered = useMemo(() => {
    if (!visibleLifecycles) return data.commitments;
    return data.commitments.filter((commitment) => visibleLifecycles.has(commitment.lifecycle));
  }, [data.commitments, visibleLifecycles]);
  const [selectedId, setSelectedId] = useState<string | null>(filtered[0]?.id ?? null);
  const selected =
    filtered.find((commitment) => commitment.id === selectedId) ?? filtered[0] ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden px-3 pb-20 pt-12">
      {/* Dataset headline — honest about truncation AND the lifecycle filter.
          Sums only the commitments whose lifecycle the filter shows against the
          rendered slice, so the count tracks the register below. */}
      <p className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {perspectiveCountLabel(
          {
            loaded: filtered.length,
            total: visibleLifecycleTotal(data.totalByLifecycle, visibleLifecycles),
          },
          "commitment",
        )}
      </p>
      <div className="grid shrink-0 grid-cols-2 gap-2 lg:grid-cols-6">
        <Metric label="Commitments" value={data.stats.commitments} />
        <Metric label="Evidence" value={`${data.stats.evidenceLinked}/${data.stats.commitments}`} />
        <Metric label="No owner" value={data.stats.missingOwner} tone="amber" />
        <Metric label="No remedy" value={data.stats.missingRemedy} tone="amber" />
        <Metric label="Review due" value={data.stats.reviewDue} tone="red" />
        <Metric label="External refs" value={data.stats.externalRefs} />
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-h-0 overflow-hidden rounded-md border border-border bg-card">
          <div className="h-full min-h-0 overflow-auto">
            <div className="sticky top-0 z-10 grid h-10 min-w-[860px] grid-cols-[minmax(230px,1.4fr)_120px_120px_120px_120px_128px] items-center border-b border-border bg-muted/35 px-3 text-[11px] font-semibold uppercase text-muted-foreground">
              <span>Agreement clause</span>
              <span>Owner</span>
              <span>Target</span>
              <span>Window</span>
              <span>Evidence</span>
              <span>Review</span>
            </div>
            {filtered.length === 0 ? (
              <div className="px-4 py-5 text-sm italic text-muted-foreground">
                No SLA commitments match the current lifecycle filter.
              </div>
            ) : (
              <ul className="min-w-[860px] divide-y divide-border">
                {filtered.map((commitment) => (
                  <CommitmentRow
                    key={commitment.id}
                    commitment={commitment}
                    selected={selected?.id === commitment.id}
                    onSelect={() => setSelectedId(commitment.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        <SlaDetail commitment={selected} />
      </div>
    </div>
  );
}

function CommitmentRow({
  commitment,
  selected,
  onSelect,
}: {
  commitment: SlaCommitment;
  selected: boolean;
  onSelect: () => void;
}) {
  const hasEvidence = commitment.evals.length > 0 || commitment.sourceRefs.length > 0;
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`grid w-full grid-cols-[minmax(230px,1.4fr)_120px_120px_120px_120px_128px] items-center gap-0 px-3 py-3 text-left text-xs hover:bg-background ${
          selected ? "bg-primary/10" : "bg-card"
        }`}
      >
        <span className="min-w-0 pr-4">
          <span
            className="block whitespace-pre-line break-words text-sm font-semibold text-foreground"
            title={commitment.title}
          >
            {commitment.title}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{commitment.scope ?? "Scope unset"}</span>
          </span>
        </span>
        <span
          className="truncate pr-3 text-foreground"
          title={commitment.owner?.label ?? undefined}
        >
          {commitment.owner?.label ?? <Missing label="No owner" />}
        </span>
        <span
          className="truncate pr-3 font-medium text-foreground"
          title={commitment.target ?? undefined}
        >
          {commitment.target ?? <Missing label="No target" />}
        </span>
        <span
          className="truncate pr-3 text-muted-foreground"
          title={commitment.measurementWindow ?? undefined}
        >
          {commitment.measurementWindow ?? <Missing label="No window" />}
        </span>
        <span>
          {hasEvidence ? (
            <Badge tone={commitment.evals.length > 0 ? "green" : "slate"}>
              {commitment.evals.length > 0 && commitment.sourceRefs.length > 0
                ? "Eval + ref"
                : commitment.evals.length > 0
                  ? "Eval"
                  : "Ref"}
            </Badge>
          ) : (
            <Badge tone="amber">No evidence</Badge>
          )}
        </span>
        <span>
          {commitment.reviewDate ? (
            <Badge tone={commitment.warnings.includes("Review due") ? "red" : "slate"}>
              {formatDate(commitment.reviewDate)}
            </Badge>
          ) : (
            <Badge tone="amber">No review</Badge>
          )}
        </span>
      </button>
    </li>
  );
}

function SlaDetail({ commitment }: { commitment: SlaCommitment | null }) {
  if (!commitment) {
    return (
      <aside className="min-h-0 rounded-md border border-border bg-card p-4 text-sm italic text-muted-foreground">
        No SLA commitment selected.
      </aside>
    );
  }

  return (
    <aside className="min-h-0 overflow-auto rounded-md border border-border bg-card">
      <div className="border-b border-border bg-muted/30 px-4 py-3">
        <p className="text-[11px] font-semibold uppercase text-muted-foreground">
          Selected commitment
        </p>
        <Link
          to={commitment.href}
          className="mt-1 block text-base font-semibold text-foreground hover:underline"
        >
          {commitment.title}
        </Link>
      </div>
      <div className="space-y-4 p-4 text-sm">
        <Section title="Contract Definition">
          <Field label="Metric" value={commitment.metric ?? "Not set"} warn={!commitment.metric} />
          <Field label="Target" value={commitment.target ?? "Not set"} warn={!commitment.target} />
          <Field
            label="Window"
            value={commitment.measurementWindow ?? "Not set"}
            warn={!commitment.measurementWindow}
          />
          <Field label="Scope" value={commitment.scope ?? "Not set"} warn={!commitment.scope} />
          <Field
            label="Exclusions"
            value={commitment.exclusions ?? "Not set"}
            warn={!commitment.exclusions}
          />
          <Field label="Remedy" value={commitment.remedy ?? "Not set"} warn={!commitment.remedy} />
        </Section>

        <Section title="Evidence Pointers">
          <LinkList links={commitment.evals} empty="No Eval linked" icon="eval" />
          <LinkList
            links={commitment.sourceRefs}
            empty="No source Reference linked"
            icon="reference"
          />
        </Section>

        <Section title="Ownership And Response">
          {commitment.owner ? (
            <LinkRow link={commitment.owner} />
          ) : (
            <p className="text-xs text-amber-700">No owner Principal linked.</p>
          )}
          <LinkList
            links={commitment.responseActions}
            empty="No response Action linked"
            icon="action"
          />
          <LinkList
            links={commitment.changeDecisions}
            empty="No change Decision linked"
            icon="decision"
          />
        </Section>

        <Section title="Open Gaps">
          {commitment.warnings.length === 0 ? (
            <p className="inline-flex items-center gap-2 text-xs text-green-700">
              <CheckCircle2 className="h-4 w-4" />
              Register fields look complete.
            </p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {commitment.warnings.map((warning) => (
                <Badge key={warning} tone={warning === "Review due" ? "red" : "amber"}>
                  {warning}
                </Badge>
              ))}
            </div>
          )}
        </Section>
      </div>
    </aside>
  );
}

function Metric({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: number | string;
  tone?: "slate" | "amber" | "red";
}) {
  const toneClass =
    tone === "red" ? "text-red-700" : tone === "amber" ? "text-amber-700" : "text-foreground";
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2">
      <p className="text-[11px] font-semibold uppercase text-muted-foreground">{label}</p>
      <p className={`mt-1 text-xl font-semibold tabular-nums ${toneClass}`}>{value}</p>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-semibold uppercase text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={warn ? "text-amber-700" : "text-foreground"}>{value}</span>
    </div>
  );
}

function LinkList({
  links,
  empty,
  icon,
}: {
  links: SlaLink[];
  empty: string;
  icon: "eval" | "reference" | "action" | "decision";
}) {
  if (links.length === 0) return <p className="text-xs text-amber-700">{empty}</p>;
  return (
    <div className="space-y-1">
      {links.map((link) => (
        <LinkRow key={`${icon}:${link.id}`} link={link} icon={icon} />
      ))}
    </div>
  );
}

function LinkRow({
  link,
  icon,
}: { link: SlaLink; icon?: "eval" | "reference" | "action" | "decision" }) {
  const Icon = icon === "reference" ? FileText : icon === "eval" ? CheckCircle2 : ExternalLink;
  return (
    <Link
      to={link.href}
      className="flex min-w-0 items-center gap-2 rounded border border-border bg-background px-2 py-1.5 text-xs hover:bg-muted/40"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 whitespace-pre-line break-words">{link.label}</span>
    </Link>
  );
}

function Badge({
  children,
  tone,
}: { children: ReactNode; tone: "green" | "amber" | "red" | "slate" }) {
  const cls =
    tone === "green"
      ? "border-green-200 bg-green-50 text-green-700"
      : tone === "amber"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : tone === "red"
          ? "border-red-200 bg-red-50 text-red-700"
          : "border-border bg-muted/45 text-muted-foreground";
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {children}
    </span>
  );
}

function Missing({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-amber-700">
      <AlertTriangle className="h-3.5 w-3.5" />
      {label}
    </span>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "2-digit" }).format(date);
}
