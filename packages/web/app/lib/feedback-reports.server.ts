import { withClient } from "@doco/db";
import { generateUlid } from "@doco/shared";

export type FeedbackReportType = "bug" | "idea";
export type FeedbackReportStatus = "new" | "reviewed" | "archived";

export interface FeedbackReportInput {
  report_type: FeedbackReportType;
  title: string;
  body: string;
  expected: string;
  actual: string;
  severity: string;
  page_url: string;
  route_path: string;
  client_context: unknown;
  data: unknown;
}

export interface FeedbackReportRow extends FeedbackReportInput {
  id: string;
  status: FeedbackReportStatus;
  created_by: string | null;
  created_by_username: string;
  server_context: unknown;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
}

function asDateString(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

export function parseFeedbackReportInput(value: unknown): FeedbackReportInput | { error: string } {
  if (!isRecord(value)) return { error: "Expected a JSON object." };
  const reportType =
    value.report_type === "idea" ? "idea" : value.report_type === "bug" ? "bug" : null;
  if (!reportType) return { error: "Pick bug or idea." };

  const title = text(value.title, 240);
  const body = text(value.body, 12_000);
  if (!title && !body) return { error: "Add a title or a few details." };

  return {
    report_type: reportType,
    title,
    body,
    expected: text(value.expected, 6_000),
    actual: text(value.actual, 6_000),
    severity: text(value.severity, 80),
    page_url: text(value.page_url, 2_000),
    route_path: text(value.route_path, 1_000),
    client_context: isRecord(value.client_context) ? value.client_context : {},
    data: isRecord(value.data) ? value.data : {},
  };
}

export function serverContextFromRequest(request: Request): Record<string, unknown> {
  const header = (name: string) => request.headers.get(name) ?? "";
  return {
    request_url: request.url,
    method: request.method,
    user_agent: header("user-agent"),
    accept_language: header("accept-language"),
    referer: header("referer"),
    origin: header("origin"),
    host: header("host"),
    forwarded_for: header("x-forwarded-for"),
    real_ip: header("x-real-ip"),
    vercel_ip_country: header("x-vercel-ip-country"),
    vercel_ip_region: header("x-vercel-ip-country-region"),
    vercel_ip_city: header("x-vercel-ip-city"),
    sec_ch_ua: header("sec-ch-ua"),
    sec_ch_ua_platform: header("sec-ch-ua-platform"),
    sec_ch_ua_mobile: header("sec-ch-ua-mobile"),
  };
}

export async function createFeedbackReport(args: {
  input: FeedbackReportInput;
  createdBy: string;
  createdByUsername: string;
  serverContext: Record<string, unknown>;
}): Promise<FeedbackReportRow> {
  const id = `feedback_${generateUlid()}`;
  const result = await withClient((c) =>
    c.query<
      Omit<FeedbackReportRow, "created_at" | "updated_at" | "reviewed_at"> & {
        created_at: Date | string;
        updated_at: Date | string;
        reviewed_at: Date | string | null;
      }
    >(
      `INSERT INTO feedback_reports (
         id, report_type, title, body, expected, actual, severity, page_url, route_path,
         created_by, created_by_username, client_context, server_context, data
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb)
       RETURNING id, report_type, status, title, body, expected, actual, severity, page_url,
                 route_path, created_by, created_by_username, client_context, server_context,
                 data, created_at, updated_at, reviewed_at, reviewed_by`,
      [
        id,
        args.input.report_type,
        args.input.title,
        args.input.body,
        args.input.expected,
        args.input.actual,
        args.input.severity,
        args.input.page_url,
        args.input.route_path,
        args.createdBy,
        args.createdByUsername,
        JSON.stringify(args.input.client_context),
        JSON.stringify(args.serverContext),
        JSON.stringify(args.input.data),
      ],
    ),
  );
  const row = result.rows[0];
  return {
    ...row,
    created_at: asDateString(row.created_at) ?? "",
    updated_at: asDateString(row.updated_at) ?? "",
    reviewed_at: asDateString(row.reviewed_at),
  };
}

export interface FeedbackPendingCounts {
  bugs: number;
  ideas: number;
}

/**
 * Count uncleared (non-archived) bug and idea reports. "Cleared" maps to the
 * `archived` status — a report stays pending until Torrenegra clears it from
 * the feedback page. Drives the bug / lightbulb flags shown beside the version
 * pill in the header, so it runs on every page load for that one account and
 * stays a single grouped aggregate over the whole table (never the truncated
 * list view).
 */
export async function countPendingFeedback(): Promise<FeedbackPendingCounts> {
  const result = await withClient((c) =>
    c.query<{ report_type: FeedbackReportType; n: number | string }>(
      `SELECT report_type, count(*)::int AS n
         FROM feedback_reports
        WHERE status <> 'archived'
        GROUP BY report_type`,
    ),
  );
  const counts: FeedbackPendingCounts = { bugs: 0, ideas: 0 };
  for (const row of result.rows) {
    const n = typeof row.n === "number" ? row.n : Number(row.n);
    if (row.report_type === "bug") counts.bugs = n;
    else if (row.report_type === "idea") counts.ideas = n;
  }
  return counts;
}

/**
 * Clear (archive) the uncleared reports of a type — or every type when passed
 * `"all"`. This is what the feedback page's "Clear bugs" / "Clear ideas"
 * buttons call; once a type has nothing pending its header flag disappears.
 * Already-archived rows are left untouched so re-clearing is a no-op. Returns
 * the number of rows cleared.
 */
export async function clearFeedbackReports(
  reportType: FeedbackReportType | "all",
  reviewedBy: string | null,
): Promise<number> {
  const result = await withClient((c) => {
    // RETURNING + rows.length so the count is portable across node-postgres
    // (`rowCount`) and PGlite (`affectedRows`) — both expose `rows`.
    const set = `SET status = 'archived', reviewed_at = now(), reviewed_by = $1, updated_at = now()`;
    if (reportType === "all") {
      return c.query<{ id: string }>(
        `UPDATE feedback_reports ${set} WHERE status <> 'archived' RETURNING id`,
        [reviewedBy],
      );
    }
    return c.query<{ id: string }>(
      `UPDATE feedback_reports ${set} WHERE status <> 'archived' AND report_type = $2 RETURNING id`,
      [reviewedBy, reportType],
    );
  });
  return result.rows.length;
}

export async function listFeedbackReports(limit = 100): Promise<FeedbackReportRow[]> {
  const result = await withClient((c) =>
    c.query<
      Omit<FeedbackReportRow, "created_at" | "updated_at" | "reviewed_at"> & {
        created_at: Date | string;
        updated_at: Date | string;
        reviewed_at: Date | string | null;
      }
    >(
      `SELECT id, report_type, status, title, body, expected, actual, severity, page_url,
              route_path, created_by, created_by_username, client_context, server_context,
              data, created_at, updated_at, reviewed_at, reviewed_by
         FROM feedback_reports
        ORDER BY created_at DESC
        LIMIT $1`,
      [Math.max(1, Math.min(500, limit))],
    ),
  );
  return result.rows.map((row) => ({
    ...row,
    created_at: asDateString(row.created_at) ?? "",
    updated_at: asDateString(row.updated_at) ?? "",
    reviewed_at: asDateString(row.reviewed_at),
  }));
}
