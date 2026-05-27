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
