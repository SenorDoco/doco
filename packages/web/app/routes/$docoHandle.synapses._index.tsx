// Per-Doco synapse list at /<handle>/synapses.
//
// Doco's synapses are derived from reference fields on nodes (D-017,
// fields-as-synapses). They have no surrogate id — composite PK is
// (from_id, to_id, synapse_type). This page surfaces the whole synapse set
// of the Doco so a human (or the in-page assistant) can scan how
// nodes connect, and click through to a single synapse's detail view.
//
// Listing is ordered by synapse_type, then from_id, then to_id — stable
// and predictable. We render summaries from the joined node tables
// (best-effort UNION across every entity table) so each row reads as
// "<from-summary> --serves--> <to-summary>" instead of bare IDs.

import { withClient } from "@doco/db";
import { Link } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "~/components/table";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface SynapseRow {
  from_id: string;
  from_neuron_type: string;
  from_summary: string | null;
  to_id: string;
  to_neuron_type: string;
  to_summary: string | null;
  synapse_type: string;
}

export async function loader({
  params,
  request,
}: {
  params: { docoHandle: string };
  request: Request;
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const { ownerSlug, docoSlug, handle } = ctx;
  return withClient(async (c) => {
    const rows = (
      await c.query<SynapseRow>(
        `WITH labels AS (
           SELECT id, split_part(decision, E'\n', 1) AS summary FROM decisions          WHERE doco_id = $1
           UNION ALL SELECT id, split_part(intent, E'\n', 1)   FROM intents             WHERE doco_id = $1
           UNION ALL SELECT id, split_part(idea, E'\n', 1)     FROM ideas               WHERE doco_id = $1
           UNION ALL SELECT id, split_part(rule, E'\n', 1)     FROM rules               WHERE doco_id = $1
           UNION ALL SELECT id, summary                         FROM guidance_policies   WHERE doco_id = $1
           UNION ALL SELECT id, summary                         FROM neuron_authoring_policies WHERE doco_id = $1
           UNION ALL SELECT id, split_part(action, E'\n', 1)   FROM actions             WHERE doco_id = $1
           UNION ALL SELECT id, split_part(log, E'\n', 1)      FROM logs                WHERE doco_id = $1
           UNION ALL SELECT id, split_part(eval, E'\n', 1)     FROM evals               WHERE doco_id = $1
           UNION ALL SELECT id, split_part(reference, E'\n', 1) FROM reference_entities WHERE doco_id = $1
         )
         SELECT e.from_id, e.from_neuron_type, fl.summary AS from_summary,
                e.to_id,   e.to_neuron_type,   tl.summary AS to_summary,
                e.synapse_type
           FROM synapses e
           LEFT JOIN labels fl ON fl.id = e.from_id
           LEFT JOIN labels tl ON tl.id = e.to_id
          WHERE e.doco_id = $1
          ORDER BY e.synapse_type, e.from_id, e.to_id
          LIMIT 500`,
        [ctx.meta.docoId],
      )
    ).rows;
    return {
      synapses: rows,
      handle,
      ownerSlug,
      docoSlug,
      host: await loadHostConfig(),
      me: await getCurrentPrincipal(request),
    };
  });
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Synapses · Doco" }];
  return [{ title: `Synapses · ${data.handle} · Doco` }];
}

function synapseKey(e: { synapse_type: string; from_id: string; to_id: string }): string {
  return `${e.synapse_type}__${e.from_id}__${e.to_id}`;
}

export default function SynapsesIndex({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { synapses, handle, ownerSlug, me } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-6 space-y-4">
        <Breadcrumb items={docoBreadcrumb({ ownerSlug, handle, pageLabel: "Synapses" })} />
        <header className="flex items-baseline justify-between gap-3">
          <h1 className="text-2xl font-semibold">Synapses</h1>
          <div className="text-xs text-muted-foreground">
            {synapses.length} synapse{synapses.length === 1 ? "" : "s"}
          </div>
        </header>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Every synapse in this Doco</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {synapses.length === 0 ? (
              <p className="px-5 py-6 text-xs text-muted-foreground">
                No synapses yet. Synapses materialize automatically when a neuron references another
                neuron (e.g. a Decision's intent_ids). Patch a neuron's reference field and the
                synapse appears.
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[28%]">From</TableHead>
                    <TableHead className="w-[18%]">Synapse</TableHead>
                    <TableHead className="w-[34%]">To</TableHead>
                    <TableHead className="w-[18%] text-right">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {synapses.map((e) => (
                    <TableRow key={synapseKey(e)}>
                      <TableCell>
                        <Link
                          to={`/${handle}/${e.from_neuron_type}/${e.from_id}`}
                          className="text-primary hover:underline"
                        >
                          {e.from_summary ?? e.from_id}
                        </Link>
                        <div className="text-[10px] text-muted-foreground">
                          {e.from_neuron_type}
                        </div>
                      </TableCell>
                      <TableCell>
                        <code className="rounded bg-input px-1.5 py-0.5 font-mono text-[11px]">
                          {e.synapse_type}
                        </code>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/${handle}/${e.to_neuron_type}/${e.to_id}`}
                          className="text-primary hover:underline"
                        >
                          {e.to_summary ?? e.to_id}
                        </Link>
                        <div className="text-[10px] text-muted-foreground">{e.to_neuron_type}</div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Link
                          to={`/${handle}/synapses/${synapseKey(e)}`}
                          className="text-xs text-primary hover:underline"
                        >
                          open →
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
