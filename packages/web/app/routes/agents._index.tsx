// /agents — list the owner's agent Roles. Per ADR-071.
import { Link, redirect } from "react-router";
import { listPrincipals } from "@doco/db";
import { loadHostConfig } from "~/lib/host";
import { getCurrentPrincipal } from "~/lib/session";
import { SiteHeader } from "~/components/site-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";

interface AgentRow {
  id: string;
  username: string;
  display_name: string;
  model: string;
  provider: string;
  created_at: string;
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");

  // Postgres-only — list agents owned by `me`
  // (rule_01KRKQDHWNWJAF4YKTMCB2A0D9).
  const rows = await listPrincipals({ type: "agent" });
  const agents: AgentRow[] = [];
  for (const r of rows) {
    const fm = JSON.parse(r.raw_yaml) as Record<string, unknown>;
    if (fm.owner_id !== me.id) continue;
    const m = (fm.agent_metadata ?? {}) as { model?: string; provider?: string };
    agents.push({
      id: r.id,
      username: r.username,
      display_name: r.display_name ?? r.username,
      model: m.model ?? "—",
      provider: m.provider ?? "—",
      created_at: (fm.created_at as string) ?? "",
    });
  }
  agents.sort((a, b) => b.created_at.localeCompare(a.created_at));

  return { me, host: await loadHostConfig(), agents };
}

export function meta() {
  return [{ title: "Your agents · Doco" }];
}

export default function AgentsList({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me, host, agents } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-3xl px-6 py-8 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Your agents ({agents.length})</h1>
            <p className="text-xs text-muted-foreground">
              Long-lived agent Principals you own. Each has its own DOCO_ACCESS.
            </p>
          </div>
          <Link
            to="/agents/new"
            className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
          >
            + New agent
          </Link>
        </div>

        {agents.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">No agents yet</CardTitle>
            <CardDescription>
                Create one to get a Doco access credential your tools can use to act on your behalf.
                Per ADR-071.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                to="/agents/new"
                className="rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90"
              >
                Create your first agent
              </Link>
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent>
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="py-2">display_name</th>
                    <th className="py-2">model</th>
                    <th className="py-2">provider</th>
                    <th className="py-2">created</th>
                    <th className="py-2">id</th>
                  </tr>
                </thead>
                <tbody>
                  {agents.map((a) => (
                    <tr key={a.id} className="border-t border-border">
                      <td className="py-2 font-semibold">{a.display_name}</td>
                      <td className="py-2">{a.model}</td>
                      <td className="py-2">{a.provider}</td>
                      <td className="py-2 text-muted-foreground">{a.created_at}</td>
                      <td className="py-2 font-mono text-[10px] text-muted-foreground">{a.id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
