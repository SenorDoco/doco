// /admin/agent-usage — torrenegra-only token consumption dashboard.
//
// Surfaces the live cost burn from the two paid AI keys Doco holds:
//   * Anthropic (Señor Doco + the authoring-policy judge), pulled
//     from `agent_turn_metrics` (input/output/cache token totals per
//     turn, captured by the telemetry that ships every chat reply).
//   * OpenAI (text-embedding-3-small for vector search), pulled from
//     `openai_usage_log` (one row per embed batch; the embedding
//     provider wraps the call to record).
//
// Auth: gated to the `torrenegra` collaborator only. Every other
// signed-in or anonymous request gets a 404 so the page's existence
// isn't even revealed. Re-using `getCurrentPrincipal` keeps the
// check inline with every other route in the codebase.

import { withClient } from "@doco/db";
import { redirect } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SiteHeader } from "~/components/site-header";
import { getCurrentPrincipal } from "~/lib/session.server";

// Approximate USD cost per million tokens. Anthropic publishes these
// per-model on their pricing page; keep the constants near the
// rendering code so a future model swap is one place to update.
const ANTHROPIC_HAIKU_INPUT_USD_PER_M = 0.8;
const ANTHROPIC_HAIKU_OUTPUT_USD_PER_M = 4.0;
const ANTHROPIC_HAIKU_CACHE_READ_USD_PER_M = 0.08;
const ANTHROPIC_HAIKU_CACHE_WRITE_USD_PER_M = 1.0;
const OPENAI_EMBEDDING_USD_PER_M_TOKENS = 0.02;
// OpenAI's embedding API doesn't return usage; tokens ≈ chars / 4
// for English text is the standard rule of thumb.
const CHARS_PER_TOKEN = 4;

interface AnthropicBucket {
  turn_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_ms: number;
}

interface OpenAiBucket {
  call_count: number;
  input_count: number;
  total_chars: number;
  total_ms: number;
  errors: number;
}

interface RecentAnthropicRow {
  id: string;
  started_at: string;
  collaborator_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  total_ms: number;
  num_tool_calls: number;
  error: string | null;
}

interface RecentOpenAiRow {
  id: string;
  occurred_at: string;
  model: string;
  input_count: number;
  total_chars: number;
  request_ms: number | null;
  ok: boolean;
  error: string | null;
}

interface UsageSnapshot {
  generated_at: string;
  anthropic: {
    last_hour: AnthropicBucket;
    last_day: AnthropicBucket;
    last_30d: AnthropicBucket;
    all_time: AnthropicBucket;
  };
  openai: {
    last_hour: OpenAiBucket;
    last_day: OpenAiBucket;
    last_30d: OpenAiBucket;
    all_time: OpenAiBucket;
  };
  recent_anthropic: RecentAnthropicRow[];
  recent_openai: RecentOpenAiRow[];
}

async function aggregateAnthropic(sinceClause: string): Promise<AnthropicBucket> {
  return await withClient(async (c) => {
    const r = await c.query<{
      turn_count: string;
      input_tokens: string | null;
      output_tokens: string | null;
      cache_read_tokens: string | null;
      cache_creation_tokens: string | null;
      total_ms: string | null;
    }>(
      `SELECT COUNT(*)::text AS turn_count,
              COALESCE(SUM(input_tokens),0)::text AS input_tokens,
              COALESCE(SUM(output_tokens),0)::text AS output_tokens,
              COALESCE(SUM(cache_read_tokens),0)::text AS cache_read_tokens,
              COALESCE(SUM(cache_creation_tokens),0)::text AS cache_creation_tokens,
              COALESCE(SUM(total_ms),0)::text AS total_ms
         FROM agent_turn_metrics
        WHERE ${sinceClause}`,
    );
    const row = r.rows[0];
    return {
      turn_count: Number(row?.turn_count ?? 0),
      input_tokens: Number(row?.input_tokens ?? 0),
      output_tokens: Number(row?.output_tokens ?? 0),
      cache_read_tokens: Number(row?.cache_read_tokens ?? 0),
      cache_creation_tokens: Number(row?.cache_creation_tokens ?? 0),
      total_ms: Number(row?.total_ms ?? 0),
    };
  });
}

async function aggregateOpenAi(sinceClause: string): Promise<OpenAiBucket> {
  return await withClient(async (c) => {
    const r = await c.query<{
      call_count: string;
      input_count: string | null;
      total_chars: string | null;
      total_ms: string | null;
      errors: string | null;
    }>(
      `SELECT COUNT(*)::text AS call_count,
              COALESCE(SUM(input_count),0)::text AS input_count,
              COALESCE(SUM(total_chars),0)::text AS total_chars,
              COALESCE(SUM(request_ms),0)::text AS total_ms,
              COALESCE(SUM(CASE WHEN ok THEN 0 ELSE 1 END),0)::text AS errors
         FROM openai_usage_log
        WHERE ${sinceClause}`,
    );
    const row = r.rows[0];
    return {
      call_count: Number(row?.call_count ?? 0),
      input_count: Number(row?.input_count ?? 0),
      total_chars: Number(row?.total_chars ?? 0),
      total_ms: Number(row?.total_ms ?? 0),
      errors: Number(row?.errors ?? 0),
    };
  });
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect(`/sign-in?next=${encodeURIComponent("/admin/agent-usage")}`);
  // Gated to a single collaborator by github_login. Any other user
  // sees a 404 — the page's existence is not revealed.
  if (me.username !== "torrenegra") {
    throw new Response("Not Found", { status: 404 });
  }

  const since1h = "started_at >= now() - INTERVAL '1 hour'";
  const since24h = "started_at >= now() - INTERVAL '24 hours'";
  const since30d = "started_at >= now() - INTERVAL '30 days'";
  const sinceAll = "true";
  const occurred1h = "occurred_at >= now() - INTERVAL '1 hour'";
  const occurred24h = "occurred_at >= now() - INTERVAL '24 hours'";
  const occurred30d = "occurred_at >= now() - INTERVAL '30 days'";

  const [anth1h, anth24h, anth30d, anthAll, oai1h, oai24h, oai30d, oaiAll, recentAnth, recentOai] =
    await Promise.all([
      aggregateAnthropic(since1h),
      aggregateAnthropic(since24h),
      aggregateAnthropic(since30d),
      aggregateAnthropic(sinceAll),
      aggregateOpenAi(occurred1h),
      aggregateOpenAi(occurred24h),
      aggregateOpenAi(occurred30d),
      aggregateOpenAi("true"),
      withClient(async (c) => {
        const r = await c.query<
          Omit<RecentAnthropicRow, "started_at"> & { started_at: Date | string }
        >(
          `SELECT id, started_at, collaborator_id, model, input_tokens, output_tokens,
                cache_read_tokens, cache_creation_tokens, total_ms, num_tool_calls, error
           FROM agent_turn_metrics
          ORDER BY started_at DESC
          LIMIT 25`,
        );
        return r.rows.map(
          (row): RecentAnthropicRow => ({
            ...row,
            started_at:
              row.started_at instanceof Date
                ? row.started_at.toISOString()
                : String(row.started_at),
          }),
        );
      }),
      withClient(async (c) => {
        const r = await c.query<
          Omit<RecentOpenAiRow, "occurred_at"> & { occurred_at: Date | string }
        >(
          `SELECT id, occurred_at, model, input_count, total_chars, request_ms, ok, error
           FROM openai_usage_log
          ORDER BY occurred_at DESC
          LIMIT 25`,
        );
        return r.rows.map(
          (row): RecentOpenAiRow => ({
            ...row,
            occurred_at:
              row.occurred_at instanceof Date
                ? row.occurred_at.toISOString()
                : String(row.occurred_at),
          }),
        );
      }),
    ]);

  const snapshot: UsageSnapshot = {
    generated_at: new Date().toISOString(),
    anthropic: { last_hour: anth1h, last_day: anth24h, last_30d: anth30d, all_time: anthAll },
    openai: { last_hour: oai1h, last_day: oai24h, last_30d: oai30d, all_time: oaiAll },
    recent_anthropic: recentAnth,
    recent_openai: recentOai,
  };
  return Response.json(snapshot, {
    headers: {
      // Always go to the server — this page is for staring at a
      // dashboard, not for cache-driven page nav.
      "Cache-Control": "no-store",
    },
  });
}

// ---------- formatters / cost ----------

function fmtInt(n: number): string {
  return n.toLocaleString();
}
function fmtUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}
function anthropicCostUsd(b: AnthropicBucket): number {
  return (
    (b.input_tokens * ANTHROPIC_HAIKU_INPUT_USD_PER_M) / 1e6 +
    (b.output_tokens * ANTHROPIC_HAIKU_OUTPUT_USD_PER_M) / 1e6 +
    (b.cache_read_tokens * ANTHROPIC_HAIKU_CACHE_READ_USD_PER_M) / 1e6 +
    (b.cache_creation_tokens * ANTHROPIC_HAIKU_CACHE_WRITE_USD_PER_M) / 1e6
  );
}
function openaiTokens(b: OpenAiBucket): number {
  return Math.round(b.total_chars / CHARS_PER_TOKEN);
}
function openaiCostUsd(b: OpenAiBucket): number {
  return (openaiTokens(b) * OPENAI_EMBEDDING_USD_PER_M_TOKENS) / 1e6;
}
function fmtMs(n: number): string {
  if (n < 1000) return `${n}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  if (n < 3_600_000) return `${(n / 60_000).toFixed(1)}m`;
  return `${(n / 3_600_000).toFixed(1)}h`;
}

// ---------- page ----------

export default function AgentUsagePage({ loaderData }: { loaderData: UsageSnapshot }) {
  const s = loaderData;
  const windows: Array<{ label: string; anth: AnthropicBucket; oai: OpenAiBucket }> = [
    { label: "Last hour", anth: s.anthropic.last_hour, oai: s.openai.last_hour },
    { label: "Last 24h", anth: s.anthropic.last_day, oai: s.openai.last_day },
    { label: "Last 30d", anth: s.anthropic.last_30d, oai: s.openai.last_30d },
    { label: "All time", anth: s.anthropic.all_time, oai: s.openai.all_time },
  ];
  // Auto-refresh via a meta tag — every 30s pull a fresh snapshot
  // from the loader. Cheap and avoids a websocket / SSE for what is
  // a low-volume admin page.
  return (
    <div className="flex min-h-screen flex-col bg-background">
      <SiteHeader mode="host" />
      <meta httpEquiv="refresh" content="30" />
      <div className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold">Agent token usage</h1>
            <div className="text-[11px] text-muted-foreground">
              Live counters across Doco's Anthropic (Señor Doco + judge) and OpenAI (embeddings)
              keys. Refreshes every 30s. Snapshot at {new Date(s.generated_at).toLocaleString()}.
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Anthropic (Señor Doco + judge)</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-[11px] font-mono">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left">window</th>
                    <th className="text-right">turns</th>
                    <th className="text-right">in</th>
                    <th className="text-right">out</th>
                    <th className="text-right">cache R/W</th>
                    <th className="text-right">~$</th>
                  </tr>
                </thead>
                <tbody>
                  {windows.map((w) => (
                    <tr key={w.label}>
                      <td>{w.label}</td>
                      <td className="text-right">{fmtInt(w.anth.turn_count)}</td>
                      <td className="text-right">{fmtInt(w.anth.input_tokens)}</td>
                      <td className="text-right">{fmtInt(w.anth.output_tokens)}</td>
                      <td className="text-right">
                        {fmtInt(w.anth.cache_read_tokens)} / {fmtInt(w.anth.cache_creation_tokens)}
                      </td>
                      <td className="text-right">{fmtUsd(anthropicCostUsd(w.anth))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>OpenAI (text-embedding-3-small)</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-[11px] font-mono">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left">window</th>
                    <th className="text-right">calls</th>
                    <th className="text-right">inputs</th>
                    <th className="text-right">chars</th>
                    <th className="text-right">~tokens</th>
                    <th className="text-right">~$</th>
                    <th className="text-right">errs</th>
                  </tr>
                </thead>
                <tbody>
                  {windows.map((w) => (
                    <tr key={w.label}>
                      <td>{w.label}</td>
                      <td className="text-right">{fmtInt(w.oai.call_count)}</td>
                      <td className="text-right">{fmtInt(w.oai.input_count)}</td>
                      <td className="text-right">{fmtInt(w.oai.total_chars)}</td>
                      <td className="text-right">{fmtInt(openaiTokens(w.oai))}</td>
                      <td className="text-right">{fmtUsd(openaiCostUsd(w.oai))}</td>
                      <td className="text-right">{fmtInt(w.oai.errors)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-2 text-[10px] text-muted-foreground">
                OpenAI's embeddings API doesn't return per-request token counts, so ~tokens is
                estimated from `chars / {CHARS_PER_TOKEN}`. Cost uses the text-embedding-3-small
                list price (${OPENAI_EMBEDDING_USD_PER_M_TOKENS} / M tokens).
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Recent Anthropic turns</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-[10px] font-mono">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left">when</th>
                    <th className="text-left">user</th>
                    <th className="text-right">in</th>
                    <th className="text-right">out</th>
                    <th className="text-right">cache R</th>
                    <th className="text-right">tools</th>
                    <th className="text-right">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {s.recent_anthropic.map((r) => (
                    <tr key={r.id} className={r.error ? "text-destructive" : ""}>
                      <td>{new Date(r.started_at).toLocaleTimeString()}</td>
                      <td className="truncate" title={r.collaborator_id}>
                        {r.collaborator_id.slice(-6)}
                      </td>
                      <td className="text-right">{fmtInt(r.input_tokens)}</td>
                      <td className="text-right">{fmtInt(r.output_tokens)}</td>
                      <td className="text-right">{fmtInt(r.cache_read_tokens)}</td>
                      <td className="text-right">{r.num_tool_calls}</td>
                      <td className="text-right">{fmtMs(r.total_ms)}</td>
                    </tr>
                  ))}
                  {s.recent_anthropic.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="py-2 text-center text-muted-foreground">
                        (no recent turns)
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent OpenAI embed batches</CardTitle>
            </CardHeader>
            <CardContent>
              <table className="w-full text-[10px] font-mono">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="text-left">when</th>
                    <th className="text-right">inputs</th>
                    <th className="text-right">chars</th>
                    <th className="text-right">~tok</th>
                    <th className="text-right">ms</th>
                    <th className="text-left">err</th>
                  </tr>
                </thead>
                <tbody>
                  {s.recent_openai.map((r) => (
                    <tr key={r.id} className={r.ok ? "" : "text-destructive"}>
                      <td>{new Date(r.occurred_at).toLocaleTimeString()}</td>
                      <td className="text-right">{fmtInt(r.input_count)}</td>
                      <td className="text-right">{fmtInt(r.total_chars)}</td>
                      <td className="text-right">
                        {fmtInt(Math.round(r.total_chars / CHARS_PER_TOKEN))}
                      </td>
                      <td className="text-right">
                        {r.request_ms === null ? "—" : fmtMs(r.request_ms)}
                      </td>
                      <td className="truncate" title={r.error ?? ""}>
                        {r.error ? r.error.slice(0, 30) : ""}
                      </td>
                    </tr>
                  ))}
                  {s.recent_openai.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-2 text-center text-muted-foreground">
                        (no recent embed batches)
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
