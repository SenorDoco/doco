// Per-Doco synapse detail at /<handle>/synapses/<synapse-key>.
//
// `synapseKey` encodes the composite PK as `<synapse_type>__<from_id>__<to_id>`.
// Underscore-double is rare in any of the prefixes — neuron ids are
// `<type>_<ULID>`, synapse_type is a single lowercase word with no double
// underscore, and the type prefix never contains an underscore-pair
// either — so the simple split-on-`__` is unambiguous.
//
// Renders the two connected neurons via EntityGraph (the same mini-graph
// component the entity detail page uses) and surfaces the metadata a
// synapse carries: type and props blob if present.

import { withClient } from "@doco/db";
import { Link } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { EntityGraph, type GraphLink, type GraphNode } from "~/components/entity-graph";
import { SiteHeader } from "~/components/site-header";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface SynapseRow {
  from_id: string;
  from_neuron_type: string;
  to_id: string;
  to_neuron_type: string;
  synapse_type: string;
  synapse_props_json: Record<string, unknown> | null;
}

interface NeuronLabel {
  id: string;
  summary: string | null;
  lifecycle: string | null;
  created_at: string | null;
}

function parseSynapseKey(
  synapseKey: string,
): { synapse_type: string; from_id: string; to_id: string } | null {
  const parts = synapseKey.split("__");
  if (parts.length !== 3) return null;
  const [synapse_type, from_id, to_id] = parts as [string, string, string];
  if (!synapse_type || !from_id || !to_id) return null;
  return { synapse_type, from_id, to_id };
}

export async function loader({
  params,
  request,
}: {
  params: { docoHandle: string; synapseKey: string };
  request: Request;
}) {
  const parsed = parseSynapseKey(params.synapseKey);
  if (!parsed) {
    throw new Response(`Bad synapse key: ${params.synapseKey}`, { status: 404 });
  }
  const ctx = await loadDocoRouteForRead(request, params);
  const { handle, ownerSlug } = ctx;

  return withClient(async (c) => {
    const synapseQuery = await c.query<SynapseRow>(
      `SELECT from_id, from_neuron_type, to_id, to_neuron_type, synapse_type, synapse_props_json
         FROM synapses
        WHERE doco_id = $1 AND synapse_type = $2 AND from_id = $3 AND to_id = $4`,
      [ctx.meta.docoId, parsed.synapse_type, parsed.from_id, parsed.to_id],
    );
    const synapse = synapseQuery.rows[0];
    if (!synapse) {
      throw new Response("Synapse not found", { status: 404 });
    }
    const labelRows = (
      await c.query<NeuronLabel>(
        `WITH labels AS (
           SELECT id, split_part(decision, E'\n', 1) AS summary, lifecycle, created_at FROM decisions             WHERE doco_id = $1
           UNION ALL SELECT id, split_part(intent, E'\n', 1), lifecycle, created_at FROM intents                  WHERE doco_id = $1
           UNION ALL SELECT id, split_part(idea, E'\n', 1), lifecycle, created_at FROM ideas                    WHERE doco_id = $1
           UNION ALL SELECT id, split_part(rule, E'\n', 1), lifecycle, created_at FROM rules                    WHERE doco_id = $1
           UNION ALL SELECT id, policy, lifecycle, created_at FROM guidance_policies        WHERE doco_id = $1
           UNION ALL SELECT id, policy, lifecycle, created_at FROM neuron_authoring_policies  WHERE doco_id = $1
           UNION ALL SELECT id, split_part(action, E'\n', 1), lifecycle, created_at FROM actions                  WHERE doco_id = $1
           UNION ALL SELECT id, split_part(log, E'\n', 1), lifecycle, created_at FROM logs                     WHERE doco_id = $1
           UNION ALL SELECT id, split_part(eval, E'\n', 1), lifecycle, created_at FROM evals                    WHERE doco_id = $1
           UNION ALL SELECT id, split_part(reference, E'\n', 1), lifecycle, created_at FROM reference_entities       WHERE doco_id = $1
         )
         SELECT id, summary, lifecycle, created_at FROM labels WHERE id = ANY($2)`,
        [ctx.meta.docoId, [synapse.from_id, synapse.to_id]],
      )
    ).rows;
    const byId = new Map(labelRows.map((r) => [r.id, r] as const));
    return {
      synapse,
      from_label: byId.get(synapse.from_id) ?? null,
      to_label: byId.get(synapse.to_id) ?? null,
      handle,
      ownerSlug,
      host: await loadHostConfig(),
      me: await getCurrentPrincipal(request),
    };
  });
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Synapse · Doco" }];
  return [{ title: `${data.synapse.synapse_type} · ${data.handle} · Doco` }];
}

export default function SynapseDetail({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { synapse, from_label, to_label, handle, ownerSlug, me } = loaderData;

  const nodes: GraphNode[] = [
    {
      id: synapse.from_id,
      entity_type: synapse.from_neuron_type,
      summary: from_label?.summary ?? synapse.from_id,
      name: null,
      lifecycle: from_label?.lifecycle ?? "accepted",
      created_at: from_label?.created_at ?? null,
      ppr: 1,
      gpr: 0,
      is_center: true,
    },
    {
      id: synapse.to_id,
      entity_type: synapse.to_neuron_type,
      summary: to_label?.summary ?? synapse.to_id,
      name: null,
      lifecycle: to_label?.lifecycle ?? "accepted",
      created_at: to_label?.created_at ?? null,
      ppr: 0.5,
      gpr: 0,
    },
  ];
  const links: GraphLink[] = [
    {
      source: synapse.from_id,
      target: synapse.to_id,
      synapse_type: synapse.synapse_type,
    },
  ];

  const propsEntries: [string, unknown][] = synapse.synapse_props_json
    ? Object.entries(synapse.synapse_props_json)
    : [];

  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Breadcrumb
          items={docoBreadcrumb({
            ownerSlug,
            handle,
            parent: { label: "Synapses", to: `/${handle}/synapses` },
            pageLabel: synapse.synapse_type,
          })}
        />
        <header className="flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold">
            <Link
              to={`/${handle}/${synapse.from_neuron_type}/${synapse.from_id}`}
              className="text-primary hover:underline"
            >
              {from_label?.summary ?? synapse.from_id}
            </Link>{" "}
            <code className="rounded bg-input px-1.5 py-0.5 font-mono text-base">
              {synapse.synapse_type}
            </code>{" "}
            <Link
              to={`/${handle}/${synapse.to_neuron_type}/${synapse.to_id}`}
              className="text-primary hover:underline"
            >
              {to_label?.summary ?? synapse.to_id}
            </Link>
          </h1>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Graph</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[420px] w-full">
              <EntityGraph
                centerId={synapse.from_id}
                nodes={nodes}
                links={links}
                hrefFor={(id, nt) => `/${handle}/${nt}/${id}`}
                layoutMode="cluster"
                showPersonalizedRank={false}
                fillHeight
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="px-5 py-3">
            <CardTitle className="text-sm">Metadata</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <dl className="grid grid-cols-[160px_1fr] gap-x-4 gap-y-1 px-5 py-3 text-xs">
              <dt className="text-muted-foreground">synapse_type</dt>
              <dd>
                <code className="font-mono">{synapse.synapse_type}</code>
              </dd>
              <dt className="text-muted-foreground">from</dt>
              <dd>
                <code className="font-mono text-[11px]">{synapse.from_id}</code>{" "}
                <span className="text-muted-foreground">({synapse.from_neuron_type})</span>
              </dd>
              <dt className="text-muted-foreground">to</dt>
              <dd>
                <code className="font-mono text-[11px]">{synapse.to_id}</code>{" "}
                <span className="text-muted-foreground">({synapse.to_neuron_type})</span>
              </dd>
              {propsEntries.length > 0 ? (
                <>
                  <dt className="text-muted-foreground">props</dt>
                  <dd>
                    <pre className="overflow-auto rounded bg-input px-2 py-1.5 font-mono text-[11px]">
                      {JSON.stringify(synapse.synapse_props_json, null, 2)}
                    </pre>
                  </dd>
                </>
              ) : null}
            </dl>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
