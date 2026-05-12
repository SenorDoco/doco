// /agents — list the human's owned agent Roles. Per ADR-071.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Link, redirect } from "react-router";
import { parse as parseYaml } from "yaml";
import { rootDir } from "~/lib/db";
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
  const me = getCurrentPrincipal(request);
  if (!me) throw redirect("/sign-in");

  const dir = join(rootDir(), "principals");
  const agents: AgentRow[] = [];
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("principal_") || !name.endsWith(".yaml")) continue;
      const e = parseYaml(readFileSync(join(dir, name), "utf8")) as Record<string, unknown>;
      if (e.type !== "agent") continue;
      if (e.owner_id !== me.id) continue;
      const meta = (e.agent_metadata ?? {}) as { model?: string; provider?: string };
      agents.push({
        id: e.id as string,
        username: e.username as string,
        display_name: (e.display_name as string) ?? (e.username as string),
        model: meta.model ?? "—",
        provider: meta.provider ?? "—",
        created_at: e.created_at as string,
      });
    }
    agents.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  return { me, host: loadHostConfig(), agents };
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
      <SiteHeader context={host.name} mode="host" me={me} />
      <main className="mx-auto max-w-3xl px-6 py-8 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Your agents ({agents.length})</h1>
            <p className="text-xs text-muted-foreground">
              Long-lived non-human Principals you own. Each has its own DOCO_TOKEN.
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
                Create one to get an DOCO_TOKEN your tools can use to act on your behalf.
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
