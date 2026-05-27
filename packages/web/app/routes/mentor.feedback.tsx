import { redirect } from "react-router";
import { Badge } from "~/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { type FeedbackReportRow, listFeedbackReports } from "~/lib/feedback-reports.server";
import { getCurrentPrincipal } from "~/lib/session.server";

interface LoaderData {
  me: NonNullable<Awaited<ReturnType<typeof getCurrentPrincipal>>>;
  reports: FeedbackReportRow[];
  counts: {
    total: number;
    bugs: number;
    ideas: number;
    new: number;
  };
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) throw redirect(`/sign-in?next=${encodeURIComponent("/mentor/feedback")}`);
  if (me.username !== "torrenegra") throw new Response("Not Found", { status: 404 });

  const reports = await listFeedbackReports(150);
  return {
    me,
    reports,
    counts: {
      total: reports.length,
      bugs: reports.filter((r) => r.report_type === "bug").length,
      ideas: reports.filter((r) => r.report_type === "idea").length,
      new: reports.filter((r) => r.status === "new").length,
    },
  };
}

export function meta() {
  return [{ title: "Mentor feedback · Doco" }];
}

function displayDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonBlock(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function contextValue(report: FeedbackReportRow, key: string): string {
  const client = asRecord(report.client_context);
  const server = asRecord(report.server_context);
  const value = client[key] ?? server[key];
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function displayActivityTime(value: unknown): string {
  const raw = stringValue(value);
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function activityTargetLabel(target: Record<string, unknown>): string {
  return (
    stringValue(target.label) ||
    stringValue(target.aria_label) ||
    stringValue(target.text) ||
    stringValue(target.placeholder) ||
    stringValue(target.name) ||
    stringValue(target.id) ||
    stringValue(target.href) ||
    stringValue(target.tag) ||
    "page"
  );
}

function activitySummary(value: unknown): string {
  const activity = asRecord(value);
  const page = asRecord(activity.page);
  const target = asRecord(activity.target);
  const kind = stringValue(activity.kind).replace(/_/g, " ") || "activity";
  const pagePath =
    [stringValue(page.pathname), stringValue(page.search), stringValue(page.hash)]
      .filter(Boolean)
      .join("") || stringValue(page.href);
  const details = [
    displayActivityTime(activity.at),
    kind,
    activityTargetLabel(target),
    pagePath ? `on ${pagePath}` : "",
  ].filter(Boolean);
  return details.join(" - ");
}

export default function MentorFeedbackPage({ loaderData }: { loaderData: LoaderData }) {
  const { reports, counts, me } = loaderData;
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <SiteHeader mode="host" me={me} />
      <SingleColumnPageMain className="space-y-6 py-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold">Mentor feedback</h1>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge>{counts.total} total</Badge>
            <Badge>{counts.new} new</Badge>
            <Badge>{counts.bugs} bugs</Badge>
            <Badge>{counts.ideas} ideas</Badge>
          </div>
        </header>

        {reports.length === 0 ? (
          <p className="text-sm text-muted-foreground">No reports yet.</p>
        ) : (
          <div className="space-y-4">
            {reports.map((report) => (
              <ReportCard key={report.id} report={report} />
            ))}
          </div>
        )}
      </SingleColumnPageMain>
    </div>
  );
}

function ReportCard({ report }: { report: FeedbackReportRow }) {
  const client = asRecord(report.client_context);
  const browser = asRecord(client.browser);
  const viewport = asRecord(client.viewport);
  const app = asRecord(client.app);
  const activity = asRecord(client.activity);
  const currentPage = asRecord(activity.current_page);
  const recentActivity = asArray(activity.recent).slice(-10).reverse();
  const server = asRecord(report.server_context);
  const title = report.title || (report.report_type === "bug" ? "Untitled bug" : "Untitled idea");

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap gap-2 text-xs">
              <Badge>{report.report_type}</Badge>
              <Badge>{report.status}</Badge>
              {report.severity ? <Badge>{report.severity}</Badge> : null}
            </div>
            <CardTitle className="break-words">{title}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              {displayDate(report.created_at)} by {report.created_by_username || "unknown"}
            </p>
          </div>
          {report.page_url ? (
            <a
              href={report.page_url}
              className="neu-button rounded-md px-3 py-1.5 text-xs font-semibold"
            >
              Open page
            </a>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {report.body ? <p className="whitespace-pre-wrap text-sm">{report.body}</p> : null}

        {report.expected || report.actual ? (
          <div className="grid gap-3 md:grid-cols-2">
            {report.expected ? (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">
                  {report.report_type === "bug" ? "Expected" : "Why it matters"}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{report.expected}</p>
              </div>
            ) : null}
            {report.actual ? (
              <div>
                <p className="text-xs font-semibold uppercase text-muted-foreground">
                  {report.report_type === "bug" ? "Actual" : "Where it belongs"}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm">{report.actual}</p>
              </div>
            ) : null}
          </div>
        ) : null}

        <dl className="grid gap-2 text-xs md:grid-cols-2">
          <div>
            <dt className="font-semibold text-muted-foreground">Page title</dt>
            <dd className="break-words font-mono">
              {stringValue(currentPage.title) || contextValue(report, "title") || "-"}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Page URL</dt>
            <dd className="break-all font-mono">
              {report.page_url || stringValue(currentPage.href) || "-"}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Route</dt>
            <dd className="break-all font-mono">{report.route_path || "-"}</dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Release</dt>
            <dd className="font-mono">
              {typeof app.alpha_text === "string" ? app.alpha_text : "-"}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Viewport</dt>
            <dd className="font-mono">
              {String(viewport.width ?? "-")} x {String(viewport.height ?? "-")} @{" "}
              {String(viewport.device_pixel_ratio ?? "-")}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Browser</dt>
            <dd className="break-words font-mono">
              {typeof browser.user_agent === "string"
                ? browser.user_agent
                : contextValue(report, "user_agent") || "-"}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Server country</dt>
            <dd className="font-mono">
              {typeof server.vercel_ip_country === "string" ? server.vercel_ip_country : "-"}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-muted-foreground">Selected text</dt>
            <dd className="break-words">
              {typeof client.selected_text === "string" && client.selected_text
                ? client.selected_text
                : "-"}
            </dd>
          </div>
        </dl>

        {recentActivity.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase text-muted-foreground">Recent activity</p>
            <ol className="mt-2 space-y-1 text-xs">
              {recentActivity.map((entry, index) => (
                <li key={`${report.id}-activity-${index}`} className="break-words font-mono">
                  {activitySummary(entry)}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        <details className="text-xs">
          <summary className="cursor-pointer font-semibold text-muted-foreground">
            Full captured context
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto rounded-md bg-muted p-3 text-[11px]">
            {jsonBlock({
              client_context: report.client_context,
              server_context: report.server_context,
              data: report.data,
            })}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}
