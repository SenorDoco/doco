import { withClient } from "@doco/db";
import { Link } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NodeTypeIcon } from "~/components/node-type-icon";
import { PageHeader } from "~/components/page-header";
import {
  type PolicyItem,
  type PolicyRowData,
  PolicyView,
  toPolicyItem,
} from "~/components/policy-view";
import { canEditPolicies, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { AGENT_EXPOSURE_NOTE, POLICIES_EXPLAINER } from "~/lib/policy-copy";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  // Load every policy, active and retired — the page splits them into their own
  // sections below. (A policy's `lifecycle` defaults to 'active' when absent.)
  const rows = await withClient((c) =>
    c
      .query<PolicyRowData>(
        `SELECT id, kind, lifecycle, created_at, data
           FROM policies
          WHERE doco_id = $1
          ORDER BY created_at DESC`,
        [ctx.meta.docoId],
      )
      .then((r) => r.rows),
  );

  const policies = rows.map(toPolicyItem);
  const isRetired = (p: PolicyItem) => (p.lifecycle ?? "active") === "retired";

  return {
    ownerSlug,
    docoSlug,
    handle,
    host: await loadHostConfig(),
    canEdit: await canEditPolicies(ctx.meta, ctx.me?.id ?? null),
    activePolicies: policies.filter((p) => !isRetired(p)),
    retiredPolicies: policies.filter(isRetired),
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
  const { ownerSlug, handle, canEdit, activePolicies, retiredPolicies } = loaderData;

  return (
    <main className="mx-auto max-w-4xl px-6 py-6 space-y-4">
      <PageHeader
        breadcrumb={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Policies" })}
        title="Policies"
      >
        <p className="text-sm text-muted-foreground">
          {POLICIES_EXPLAINER} {AGENT_EXPOSURE_NOTE}
        </p>
      </PageHeader>

      <PolicySection
        title="Active policies"
        policies={activePolicies}
        handle={handle}
        canEdit={canEdit}
        emptyLabel="No active policies yet."
        showAdd={canEdit}
      />

      {retiredPolicies.length > 0 ? (
        <PolicySection
          title="Retired policies"
          policies={retiredPolicies}
          handle={handle}
          canEdit={canEdit}
          emptyLabel="No retired policies."
          showAdd={false}
        />
      ) : null}
    </main>
  );
}

function PolicySection({
  title,
  policies,
  handle,
  canEdit,
  emptyLabel,
  showAdd,
}: {
  title: string;
  policies: PolicyItem[];
  handle: string;
  canEdit: boolean;
  emptyLabel: string;
  showAdd: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <CardTitle className="flex items-center gap-2">
            <NodeTypeIcon nodeType="policy" className="h-4 w-4" />
            <span>{title}</span>
            <span className="font-mono text-xs font-normal text-muted-foreground">
              {policies.length}
            </span>
          </CardTitle>
          {showAdd ? (
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
          <p className="text-xs italic text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="divide-y divide-border">
            {policies.map((item) => (
              <PolicyRow key={item.id} item={item} handle={handle} canEdit={canEdit} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
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
    <li className="relative py-3 first:pt-0 last:pb-0">
      {/* Stretched link: clicking anywhere on the row opens the policy's own
          page. It sits BENEATH the content (a DOM sibling, not a parent — so no
          nested anchors), and the content layer is click-transparent except for
          its own links + the Modify button, which re-enable pointer events and
          paint above it. */}
      <Link
        to={`/${handle}/policies/${item.id}`}
        aria-label="Open policy"
        className="absolute inset-0 z-0 rounded-md hover:bg-input/40"
      />
      <div className="pointer-events-none relative z-10 flex items-start gap-3">
        <div className="min-w-0 flex-1 [&_a]:pointer-events-auto">
          <PolicyView item={item} />
          {/* The id, shown for reference — selectable (one click selects the
              whole thing) so it can be copied to cite the policy. pointer-events
              are re-enabled here so selecting it doesn't open the row link. */}
          <p className="pointer-events-auto mt-1.5 select-all font-mono text-[10px] text-muted-foreground/70">
            {item.id}
          </p>
        </div>
        <span className="neu-surface shrink-0 rounded px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {item.lifecycle ?? "active"}
        </span>
        {canEdit ? (
          <Link
            to={`/${handle}/policies/${item.id}/edit`}
            className="neu-button pointer-events-auto shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold text-foreground"
          >
            Modify
          </Link>
        ) : null}
      </div>
    </li>
  );
}
