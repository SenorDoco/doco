import { withClient } from "@doco/db";
import {
  POLICY_KIND_LABEL,
  type PolicyPredicate,
  agentInstructionOf,
  deterministicHeadline,
  deterministicParts,
  isDeterministicPredicate,
} from "@doco/shared";
import { Link } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { LinkedProse } from "~/components/linked-text";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { PageHeader } from "~/components/page-header";
import { SiteHeader } from "~/components/site-header";
import { canEditPolicies, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { AGENT_EXPOSURE_NOTE, POLICIES_EXPLAINER } from "~/lib/policy-copy";

type PolicyKind = "suggestion" | "deterministic" | "probabilistic";

interface PolicyRow {
  id: string;
  kind: string | null;
  lifecycle: string | null;
  created_at: Date | string | null;
  data: Record<string, unknown> | null;
}

interface PolicyItem {
  id: string;
  kind: PolicyKind;
  predicate: PolicyPredicate | null;
  lifecycle: string | null;
  createdAt: string | null;
}

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  const rows = await withClient((c) =>
    c
      .query<PolicyRow>(
        `SELECT id, kind, lifecycle, created_at, data
           FROM policies
          WHERE doco_id = $1
            AND COALESCE(lifecycle, 'active') = 'active'
          ORDER BY created_at DESC`,
        [ctx.meta.docoId],
      )
      .then((r) => r.rows),
  );

  return {
    ownerSlug,
    docoSlug,
    handle,
    me: ctx.me,
    host: await loadHostConfig(),
    canEdit: await canEditPolicies(ctx.meta, ctx.me?.id ?? null),
    policies: rows.map(toPolicyItem),
  };
}

export function meta({ params }: { params: { docoHandle?: string; docoId?: string } }) {
  return [{ title: `Policies · ${params.docoHandle ?? params.docoId ?? ""} · Doco` }];
}

export default function Policies({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { ownerSlug, handle, me, canEdit, policies } = loaderData;

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
        <PageHeader
          breadcrumb={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Policies" })}
          title="Policies"
        >
          <p className="text-sm text-muted-foreground">
            {POLICIES_EXPLAINER} {AGENT_EXPOSURE_NOTE}
          </p>
        </PageHeader>

        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <CardTitle className="flex items-center gap-2">
                <NodeTypeIcon entityType="policy" className="h-4 w-4" />
                <span>Policies</span>
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {policies.length}
                </span>
              </CardTitle>
              {canEdit ? (
                <Link
                  to={`/${handle}/policies/new`}
                  className="neu-button bg-primary text-primary-foreground hover:opacity-90 shrink-0 rounded-md px-3 py-1.5 text-sm font-semibold"
                >
                  + Add
                </Link>
              ) : null}
            </div>
          </CardHeader>
          <CardContent>
            {policies.length === 0 ? (
              <p className="text-xs italic text-muted-foreground">No policies yet.</p>
            ) : (
              <ul className="divide-y divide-border">
                {policies.map((item) => (
                  <PolicyRow key={item.id} item={item} handle={handle} canEdit={canEdit} />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

export function PolicyRow({
  item,
  handle,
  canEdit,
}: {
  item: PolicyItem;
  handle: string;
  canEdit: boolean;
}) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex items-start gap-3">
        {/* The policy text is NOT a link: the /<handle>/<type>/<id> detail
            route 404s for the `policy` type. Only Modify navigates. */}
        <div className="min-w-0 flex-1">
          <PolicyView item={item} />
        </div>
        <span className="neu-surface shrink-0 rounded px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {item.lifecycle ?? "active"}
        </span>
        {canEdit ? (
          <Link
            to={`/${handle}/policies/${item.id}/edit`}
            className="neu-button shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-foreground"
          >
            Modify
          </Link>
        ) : null}
      </div>
    </li>
  );
}

function PolicyView({ item }: { item: PolicyItem }) {
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

function toPolicyItem(row: PolicyRow): PolicyItem {
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
