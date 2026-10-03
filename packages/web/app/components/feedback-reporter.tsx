import { Bug, Lightbulb, Loader2, Send, X } from "lucide-react";
import type { FormEvent } from "react";
import { useEffect, useState } from "react";
import { useFetcher, useLocation } from "react-router";

type ReportType = "bug" | "idea";
type SubmitState = "idle" | "submitting" | "sent" | "error";
type ActivityTarget = {
  tag: string;
  role?: string;
  label?: string;
  text?: string;
  aria_label?: string;
  name?: string;
  id?: string;
  href?: string;
  type?: string;
  placeholder?: string;
};
type ActivityEntry = {
  kind: string;
  at: string;
  page: {
    href: string;
    pathname: string;
    search: string;
    hash: string;
    title: string;
  };
  target?: ActivityTarget;
  pointer?: { x: number; y: number };
  value_length?: number;
  checked?: boolean;
};

const MAX_ACTIVITY_ENTRIES = 40;
const activityTrail: ActivityEntry[] = [];

function shortText(value: string | null | undefined, max = 160): string | undefined {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function pageSnapshot() {
  return {
    href: window.location.href,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    title: document.title,
  };
}

function elementLabel(element: Element): string | undefined {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const labels = Array.from(element.labels ?? [])
      .map((label) => shortText(label.textContent, 80))
      .filter(Boolean);
    return labels[0] ?? undefined;
  }
  return undefined;
}

function summarizeElement(target: Element | null): ActivityTarget | undefined {
  const element =
    target?.closest(
      "button,a,input,textarea,select,summary,[role='button'],[role='link'],[role='menuitem'],[role='tab']",
    ) ?? target;
  if (!element) return undefined;

  const summary: ActivityTarget = { tag: element.tagName.toLowerCase() };
  const role = shortText(element.getAttribute("role"), 60);
  const ariaLabel = shortText(element.getAttribute("aria-label"), 120);
  const name = shortText(element.getAttribute("name"), 80);
  const id = shortText(element.id, 80);
  const href = element instanceof HTMLAnchorElement ? shortText(element.href, 500) : undefined;
  const type =
    element instanceof HTMLButtonElement || element instanceof HTMLInputElement
      ? shortText(element.type, 40)
      : undefined;
  const placeholder =
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? shortText(element.placeholder, 160)
      : undefined;
  const label = elementLabel(element);
  const text =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
      ? undefined
      : shortText(element.textContent, 160);

  if (role) summary.role = role;
  if (label) summary.label = label;
  if (text) summary.text = text;
  if (ariaLabel) summary.aria_label = ariaLabel;
  if (name) summary.name = name;
  if (id) summary.id = id;
  if (href) summary.href = href;
  if (type) summary.type = type;
  if (placeholder) summary.placeholder = placeholder;
  return summary;
}

function pushActivity(entry: Omit<ActivityEntry, "at" | "page">) {
  activityTrail.push({
    at: new Date().toISOString(),
    page: pageSnapshot(),
    ...entry,
  });
  if (activityTrail.length > MAX_ACTIVITY_ENTRIES) {
    activityTrail.splice(0, activityTrail.length - MAX_ACTIVITY_ENTRIES);
  }
}

function inputValueLength(element: Element | null): number | undefined {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element.value.length;
  }
  return undefined;
}

function getClientContext(): Record<string, unknown> {
  const nav = navigator as Navigator & {
    userAgentData?: {
      platform?: string;
      mobile?: boolean;
      brands?: Array<{ brand: string; version: string }>;
    };
    deviceMemory?: number;
    connection?: { effectiveType?: string; downlink?: number; rtt?: number; saveData?: boolean };
  };
  const perf = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  const scrollHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
  return {
    href: window.location.href,
    origin: window.location.origin,
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
    title: document.title,
    referrer: document.referrer,
    selected_text: window.getSelection()?.toString().slice(0, 2_000) ?? "",
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      max_y: Math.max(0, scrollHeight - window.innerHeight),
    },
    focus: summarizeElement(document.activeElement),
    activity: {
      current_page: pageSnapshot(),
      recent: activityTrail.slice(-MAX_ACTIVITY_ENTRIES),
      last: activityTrail.at(-1) ?? null,
    },
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      device_pixel_ratio: window.devicePixelRatio,
    },
    screen: {
      width: window.screen.width,
      height: window.screen.height,
      avail_width: window.screen.availWidth,
      avail_height: window.screen.availHeight,
      color_depth: window.screen.colorDepth,
    },
    browser: {
      user_agent: navigator.userAgent,
      language: navigator.language,
      languages: navigator.languages,
      platform: nav.userAgentData?.platform ?? navigator.platform,
      mobile: nav.userAgentData?.mobile,
      brands: nav.userAgentData?.brands,
      cookie_enabled: navigator.cookieEnabled,
      on_line: navigator.onLine,
      hardware_concurrency: navigator.hardwareConcurrency,
      device_memory: nav.deviceMemory,
      connection: nav.connection
        ? {
            effective_type: nav.connection.effectiveType,
            downlink: nav.connection.downlink,
            rtt: nav.connection.rtt,
            save_data: nav.connection.saveData,
          }
        : null,
    },
    time: {
      client_iso: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezone_offset_minutes: new Date().getTimezoneOffset(),
    },
    performance: perf
      ? {
          type: perf.type,
          start_time: Math.round(perf.startTime),
          duration: Math.round(perf.duration),
          dom_content_loaded: Math.round(perf.domContentLoadedEventEnd),
          load_event_end: Math.round(perf.loadEventEnd),
        }
      : null,
    app: {
      alpha_text: document.body.textContent?.match(/Alpha\s+[a-f0-9]{7}/)?.[0] ?? null,
    },
  };
}

function buttonClass(active: boolean) {
  return [
    "neu-button inline-flex h-9 items-center justify-center gap-2 rounded-md px-3 text-sm font-semibold",
    active ? "neu-pressed" : "",
  ].join(" ");
}

export function FeedbackReporter() {
  const fetcher = useFetcher<{ ok?: boolean; error?: string }>();
  const location = useLocation();
  const locationKey = `${location.pathname}${location.search}${location.hash}`;
  const [open, setOpen] = useState(false);
  const [reportType, setReportType] = useState<ReportType>("bug");
  const [body, setBody] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [state, setState] = useState<SubmitState>("idle");
  const [error, setError] = useState("");

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (fetcher.data.ok) {
      setState("sent");
      setBody("");
      return;
    }
    if (fetcher.data.error) {
      setError(fetcher.data.error);
      setState("error");
    }
  }, [fetcher.data, fetcher.state]);

  useEffect(() => {
    if (!locationKey) return;
    pushActivity({ kind: "page_view" });
  }, [locationKey]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      pushActivity({
        kind: "click",
        target: summarizeElement(event.target instanceof Element ? event.target : null),
        pointer: { x: event.clientX, y: event.clientY },
      });
    }

    function onSubmit(event: SubmitEvent) {
      pushActivity({
        kind: "form_submit",
        target: summarizeElement(event.target instanceof Element ? event.target : null),
      });
    }

    function onChange(event: Event) {
      const target = event.target instanceof Element ? event.target : null;
      pushActivity({
        kind: "field_change",
        target: summarizeElement(target),
        value_length: inputValueLength(target),
        checked: target instanceof HTMLInputElement ? target.checked : undefined,
      });
    }

    document.addEventListener("click", onClick, true);
    document.addEventListener("submit", onSubmit, true);
    document.addEventListener("change", onChange, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("submit", onSubmit, true);
      document.removeEventListener("change", onChange, true);
    };
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("submitting");
    setError("");
    const clientContext = getClientContext();
    const formData = new FormData();
    formData.set("report_type", reportType);
    formData.set("title", "");
    formData.set("body", body);
    formData.set("expected", "");
    formData.set("actual", "");
    formData.set("severity", severity);
    formData.set("page_url", window.location.href);
    formData.set("route_path", `${window.location.pathname}${window.location.search}`);
    formData.set("client_context", JSON.stringify(clientContext));
    formData.set(
      "data",
      JSON.stringify({
        form_version: 1,
        submitted_from: "floating_reporter",
      }),
    );
    fetcher.submit(formData, {
      method: "post",
      action: "/api/v1/feedback-reports.json",
    });
  }

  const isBug = reportType === "bug";

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setOpen(true);
          setState("idle");
          setError("");
        }}
        className="neu-floating fixed bottom-5 right-5 z-[60] inline-flex h-12 w-16 items-center justify-center gap-1.5 rounded-full bg-card"
        aria-label="Report a bug or idea"
        title="No bugs? An idea?"
      >
        <Bug className="h-4 w-4" aria-hidden="true" />
        <Lightbulb className="h-4 w-4" aria-hidden="true" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-[70] flex items-end justify-end bg-foreground/12 p-4 sm:p-6">
          {/* biome-ignore lint/a11y/useSemanticElements: Native dialog positioning/top-layer behavior is inconsistent for this floating reporter. */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-dialog-title"
            tabIndex={-1}
            className="neu-floating flex max-h-[min(760px,calc(100vh-2rem))] w-full max-w-xl flex-col overflow-hidden rounded-lg bg-card"
          >
            <header className="flex items-start justify-between gap-4 px-5 py-4">
              <div className="min-w-0">
                <h2 id="feedback-dialog-title" className="text-base font-semibold">
                  No bugs? An idea?
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  The page, browser, and release context ride along.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="neu-button inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
                aria-label="Close"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </header>

            <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-4">
                <div className="flex flex-wrap gap-2" aria-label="Report type">
                  <button
                    type="button"
                    className={buttonClass(isBug)}
                    aria-pressed={isBug}
                    onClick={() => setReportType("bug")}
                  >
                    <Bug className="h-4 w-4" aria-hidden="true" />
                    Bug
                  </button>
                  <button
                    type="button"
                    className={buttonClass(!isBug)}
                    aria-pressed={!isBug}
                    onClick={() => setReportType("idea")}
                  >
                    <Lightbulb className="h-4 w-4" aria-hidden="true" />
                    Idea
                  </button>
                </div>

                <label className="block text-sm">
                  <span className="font-semibold">{isBug ? "What happened" : "The idea"}</span>
                  <textarea
                    value={body}
                    onChange={(e) => setBody(e.currentTarget.value)}
                    required
                    rows={5}
                    className="mt-1 w-full rounded-md px-3 py-2"
                    placeholder={
                      isBug
                        ? "What did you click, what did you expect, and what did Doco do instead?"
                        : "What should Doco make possible, easier, or clearer?"
                    }
                  />
                </label>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-semibold">Weight</span>
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.currentTarget.value)}
                    className="rounded-md px-3 py-2"
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="blocking">Blocking</option>
                  </select>
                </label>

                {state === "sent" ? (
                  <p className="rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                    Captured. Thank you.
                  </p>
                ) : null}
                {state === "error" ? (
                  <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>

              <footer className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="neu-button rounded-md px-3 py-2 text-sm font-semibold"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={state === "submitting" || fetcher.state !== "idle"}
                  className="neu-button inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-55"
                >
                  {state === "submitting" ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Send className="h-4 w-4" aria-hidden="true" />
                  )}
                  Send
                </button>
              </footer>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}
