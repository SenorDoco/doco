// Health checks against agent_turn_metrics / capture_timings /
// openai_usage_log. Aggregates "is Doco-the-AI-side healthy right
// now?" signals into a single snapshot the admin UI and the
// public-shaped JSON endpoint both render.
//
// Signal design: each check returns its own severity. The overall
// status is the max ("ok" < "warning" < "critical"). Keeps the
// signal set easy to extend — add a row to `gather()` and a
// threshold in `evaluate()`, no other plumbing.

import { withClient } from "@doco/db";

export type Severity = "ok" | "warning" | "critical";

export interface HealthSignal {
  id: string;
  label: string;
  severity: Severity;
  value: number | null;
  threshold_warning: number | null;
  threshold_critical: number | null;
  detail: string;
}

export interface HealthSnapshot {
  generated_at: string;
  status: Severity;
  signals: HealthSignal[];
}

function maxSeverity(a: Severity, b: Severity): Severity {
  const rank: Record<Severity, number> = { ok: 0, warning: 1, critical: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function classify(value: number, warn: number, crit: number): Severity {
  if (value >= crit) return "critical";
  if (value >= warn) return "warning";
  return "ok";
}

export async function getAgentHealth(): Promise<HealthSnapshot> {
  const raw = await withClient(async (c) => {
    const [stuck, lastHourTurns, lastDayTurns, lastHourCaptures, lastHourOai] = await Promise.all([
      c.query<{
        stuck_count: string;
        oldest_start: string | null;
      }>(
        `SELECT COUNT(*)::text AS stuck_count,
                MAX(EXTRACT(EPOCH FROM (now() - active_turn_started_at)))::text AS oldest_start
           FROM chat_conversations
          WHERE active_turn_started_at IS NOT NULL
            AND active_turn_started_at < now() - INTERVAL '2 minutes'`,
      ),
      c.query<{
        total: string;
        errored: string;
        rate_limited: string;
        median_ttft_ms: string | null;
        median_total_ms: string | null;
      }>(
        `SELECT COUNT(*)::text AS total,
                COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END),0)::text AS errored,
                COALESCE(SUM(CASE WHEN error ILIKE '%rate_limit%' OR error ILIKE '%429%' THEN 1 ELSE 0 END),0)::text AS rate_limited,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY first_text_token_ms)::text AS median_ttft_ms,
                percentile_disc(0.5) WITHIN GROUP (ORDER BY total_ms)::text AS median_total_ms
           FROM agent_turn_metrics
          WHERE started_at >= now() - INTERVAL '1 hour'`,
      ),
      c.query<{ total: string; errored: string }>(
        `SELECT COUNT(*)::text AS total,
                COALESCE(SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END),0)::text AS errored
           FROM agent_turn_metrics
          WHERE started_at >= now() - INTERVAL '24 hours'`,
      ),
      c.query<{ total: string; errored: string }>(
        `SELECT COUNT(*)::text AS total,
                COALESCE(SUM(CASE WHEN status_code IS NULL OR status_code >= 400 THEN 1 ELSE 0 END),0)::text AS errored
           FROM capture_timings
          WHERE started_at >= now() - INTERVAL '1 hour'`,
      ),
      c.query<{ total: string; errored: string }>(
        `SELECT COUNT(*)::text AS total,
                COALESCE(SUM(CASE WHEN ok THEN 0 ELSE 1 END),0)::text AS errored
           FROM openai_usage_log
          WHERE occurred_at >= now() - INTERVAL '1 hour'`,
      ),
    ]);
    return {
      stuck: stuck.rows[0] ?? { stuck_count: "0", oldest_start: null },
      lastHourTurns: lastHourTurns.rows[0] ?? {
        total: "0",
        errored: "0",
        rate_limited: "0",
        median_ttft_ms: null,
        median_total_ms: null,
      },
      lastDayTurns: lastDayTurns.rows[0] ?? { total: "0", errored: "0" },
      lastHourCaptures: lastHourCaptures.rows[0] ?? { total: "0", errored: "0" },
      lastHourOai: lastHourOai.rows[0] ?? { total: "0", errored: "0" },
    };
  });

  const signals: HealthSignal[] = [];

  // Stuck turns. Any turn whose active_turn_started_at is more than
  // 2 minutes old probably crashed before clearing the marker. A
  // handful is suspicious; lots is a real outage.
  {
    const stuck = Number(raw.stuck.stuck_count);
    const oldest = raw.stuck.oldest_start ? Math.round(Number(raw.stuck.oldest_start)) : null;
    signals.push({
      id: "stuck_turns",
      label: "Stuck turns (>2 min)",
      severity: classify(stuck, 1, 3),
      value: stuck,
      threshold_warning: 1,
      threshold_critical: 3,
      detail:
        stuck === 0
          ? "no active turns past the 2-minute mark"
          : `${stuck} active turn${stuck === 1 ? "" : "s"}${oldest ? `, oldest ${oldest}s` : ""}`,
    });
  }

  // Turn error rate, last hour. Anything > 10% is a smell; > 25% is
  // a fire.
  {
    const total = Number(raw.lastHourTurns.total);
    const errored = Number(raw.lastHourTurns.errored);
    const pct = total === 0 ? 0 : Math.round((errored / total) * 100);
    signals.push({
      id: "turn_error_rate_1h",
      label: "Turn error rate (1h)",
      severity: classify(pct, 10, 25),
      value: pct,
      threshold_warning: 10,
      threshold_critical: 25,
      detail: total === 0 ? "no turns in last hour" : `${errored} / ${total} turns (${pct}%)`,
    });
  }

  // 24h error rate as a slower-moving sanity check.
  {
    const total = Number(raw.lastDayTurns.total);
    const errored = Number(raw.lastDayTurns.errored);
    const pct = total === 0 ? 0 : Math.round((errored / total) * 100);
    signals.push({
      id: "turn_error_rate_24h",
      label: "Turn error rate (24h)",
      severity: classify(pct, 5, 15),
      value: pct,
      threshold_warning: 5,
      threshold_critical: 15,
      detail: total === 0 ? "no turns in last 24 hours" : `${errored} / ${total} turns (${pct}%)`,
    });
  }

  // 429 occurrences in the last hour. Even one means a user hit a
  // rate-limit error; the auto-retry should have hidden it, but a
  // miss is still worth flagging.
  {
    const n = Number(raw.lastHourTurns.rate_limited);
    signals.push({
      id: "rate_limit_1h",
      label: "Anthropic 429s surfaced (1h)",
      severity: classify(n, 1, 5),
      value: n,
      threshold_warning: 1,
      threshold_critical: 5,
      detail: n === 0 ? "no rate-limit errors" : `${n} turn${n === 1 ? "" : "s"} hit a 429`,
    });
  }

  // Median total turn time. Most turns finish in 5-15s; > 30s
  // median is "Señor Doco is sluggish for everyone right now."
  {
    const ms = raw.lastHourTurns.median_total_ms ? Number(raw.lastHourTurns.median_total_ms) : null;
    signals.push({
      id: "median_turn_ms_1h",
      label: "Median turn time (1h)",
      severity: ms === null ? "ok" : classify(ms, 30_000, 60_000),
      value: ms,
      threshold_warning: 30_000,
      threshold_critical: 60_000,
      detail: ms === null ? "no turns in last hour" : `${(ms / 1000).toFixed(1)}s`,
    });
  }

  // Median time-to-first-text-token, last hour. > 10s is the user
  // staring at an empty bubble.
  {
    const ms = raw.lastHourTurns.median_ttft_ms ? Number(raw.lastHourTurns.median_ttft_ms) : null;
    signals.push({
      id: "median_ttft_ms_1h",
      label: "Median TTFT (1h)",
      severity: ms === null ? "ok" : classify(ms, 5_000, 15_000),
      value: ms,
      threshold_warning: 5_000,
      threshold_critical: 15_000,
      detail: ms === null ? "no turns in last hour" : `${(ms / 1000).toFixed(1)}s`,
    });
  }

  // Capture-endpoint error rate. Each row is a POST/PATCH against
  // /api/<type>.json; lots of 4xx means the agent is fighting the
  // body shape or the validator.
  {
    const total = Number(raw.lastHourCaptures.total);
    const errored = Number(raw.lastHourCaptures.errored);
    const pct = total === 0 ? 0 : Math.round((errored / total) * 100);
    signals.push({
      id: "capture_error_rate_1h",
      label: "Capture-API error rate (1h)",
      severity: classify(pct, 20, 50),
      value: pct,
      threshold_warning: 20,
      threshold_critical: 50,
      detail: total === 0 ? "no captures in last hour" : `${errored} / ${total} captures (${pct}%)`,
    });
  }

  // OpenAI embed failures, last hour.
  {
    const total = Number(raw.lastHourOai.total);
    const errored = Number(raw.lastHourOai.errored);
    signals.push({
      id: "openai_errors_1h",
      label: "OpenAI embed errors (1h)",
      severity: classify(errored, 1, 5),
      value: errored,
      threshold_warning: 1,
      threshold_critical: 5,
      detail:
        total === 0
          ? "no embed calls in last hour"
          : errored === 0
            ? `${total} calls, all ok`
            : `${errored} / ${total} calls errored`,
    });
  }

  const status = signals.reduce<Severity>((acc, s) => maxSeverity(acc, s.severity), "ok");
  return {
    generated_at: new Date().toISOString(),
    status,
    signals,
  };
}
