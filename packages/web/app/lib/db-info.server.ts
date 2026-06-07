// Owner-only diagnostic: where does THIS running process actually connect?
//
// The connection string lives only in the deployment's environment, so the
// most reliable way to answer "which database is production pointed at?" is to
// parse it from inside the running process. This reports host/port/database/
// user/provider with the password REDACTED — the password is a bearer
// credential and must never leak into an HTTP response, a log line, or browser
// history. We return `hasPassword` (a boolean) and a `redactedUrl` (password
// replaced by ***), never the secret itself.

export interface DatabaseSummary {
  /** Best-effort provider guess from the host suffix. */
  provider: "neon" | "supabase" | "aws-rds" | "local" | "unknown";
  host: string | null;
  port: string | null;
  database: string | null;
  user: string | null;
  /** Whether a password was present — without revealing it. */
  hasPassword: boolean;
  /** True for Neon's pooled endpoint (…-pooler…). */
  pooled: boolean;
  /** Query params (e.g. sslmode). Passwords never appear here. */
  params: Record<string, string>;
  /** The connection string with the password masked. Safe to display. */
  redactedUrl: string;
}

function detectProvider(host: string | null): DatabaseSummary["provider"] {
  if (!host) return "unknown";
  if (host.endsWith(".neon.tech")) return "neon";
  if (host.includes(".supabase.")) return "supabase";
  if (host.endsWith(".rds.amazonaws.com")) return "aws-rds";
  if (host === "localhost" || host === "127.0.0.1") return "local";
  return "unknown";
}

export function summarizeDatabaseUrl(rawUrl: string): DatabaseSummary {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return {
      provider: "unknown",
      host: null,
      port: null,
      database: null,
      user: null,
      hasPassword: false,
      pooled: false,
      params: {},
      redactedUrl: "(unparseable connection string)",
    };
  }

  const host = u.hostname || null;
  const port = u.port || null;
  const database = u.pathname.replace(/^\//, "") || null;
  const user = u.username ? decodeURIComponent(u.username) : null;
  const hasPassword = u.password !== "";
  const pooled = /(?:-pooler\.|\.pooler\.)/.test(host ?? "");

  const params: Record<string, string> = {};
  for (const [k, v] of u.searchParams) params[k] = v;

  // Rebuild the URL with the password masked — never echo the real one.
  const auth = u.username ? `${u.username}${hasPassword ? ":***" : ""}@` : "";
  const portPart = port ? `:${port}` : "";
  const redactedUrl = `${u.protocol}//${auth}${host ?? ""}${portPart}${u.pathname}${u.search}`;

  return {
    provider: detectProvider(host),
    host,
    port,
    database,
    user,
    hasPassword,
    pooled,
    params,
    redactedUrl,
  };
}

/**
 * Resolve the connection string the pool uses, mirroring the precedence in
 * `@doco/db`'s getPool() (DOCO_DATABASE_URL → DATABASE_URL → local fallback),
 * and summarize it with the password redacted.
 */
export function getDatabaseLocation(): {
  source: "DOCO_DATABASE_URL" | "DATABASE_URL" | "fallback-default";
  summary: DatabaseSummary;
} {
  if (process.env.DOCO_DATABASE_URL) {
    return {
      source: "DOCO_DATABASE_URL",
      summary: summarizeDatabaseUrl(process.env.DOCO_DATABASE_URL),
    };
  }
  if (process.env.DATABASE_URL) {
    return { source: "DATABASE_URL", summary: summarizeDatabaseUrl(process.env.DATABASE_URL) };
  }
  return {
    source: "fallback-default",
    summary: summarizeDatabaseUrl("postgres://postgres:doco@127.0.0.1:5433/doco"),
  };
}
