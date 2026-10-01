import { useLayoutEffect, useRef } from "react";
import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useLocation,
  useNavigationType,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

import { AccessDeniedView, isAccessDeniedData } from "~/components/access-denied-view";
import { AgentSidebar } from "~/components/agent-sidebar";
import { FeedbackReporter } from "~/components/feedback-reporter";
import { type FeedbackPending, SiteHeader } from "~/components/site-header";
import { countPendingAccessRequestsForOwner } from "~/lib/access-requests.server";
import { AI_INSTRUCTIONS_META } from "~/lib/agent-instructions";
import { countPendingFeedback } from "~/lib/feedback-reports.server";
import { createMainScrollRestorer } from "~/lib/main-scroll-restoration";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session.server";
import "./app.css";

// Root loader — fetch the current Principal once so the shell's header
// knows whether to offer Sign in or the nav, and whether the persistent
// AgentSidebar renders. Per-route loaders
// still fetch `me` themselves where they need it; we don't try to
// thread root data through context. For the owner we also tally uncleared
// bug/idea reports so the header can flag them beside the version pill;
// that count is best-effort and never blanks the chrome if it fails. For
// every signed-in viewer we likewise tally pending access requests on the
// Docos they own, so the header can surface an "Access requests" entry.
export async function loader({ request }: { request: Request }) {
  try {
    const me = await getCurrentPrincipal(request);
    let feedbackPending: FeedbackPending | null = null;
    if (me?.username === "torrenegra") {
      try {
        feedbackPending = await countPendingFeedback();
      } catch {
        feedbackPending = null;
      }
    }
    let accessRequestsPending = 0;
    if (me) {
      try {
        accessRequestsPending = await countPendingAccessRequestsForOwner(me.id);
      } catch {
        accessRequestsPending = 0;
      }
    }
    return { me, feedbackPending, accessRequestsPending };
  } catch {
    return {
      me: null as CurrentPrincipal | null,
      feedbackPending: null as FeedbackPending | null,
      accessRequestsPending: 0,
    };
  }
}

export function links() {
  return [
    { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
    { rel: "alternate icon", type: "image/svg+xml", href: "/favicon.svg" },
  ];
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/*
          Agent-discovery signal: a natural-language meta tag any LLM
          reading the head sees first, pointing at /agents, which holds
          the agent instructions. On root.tsx so an agent that lands on any
          internal page sees it too.
        */}
        <meta name="ai-instructions" content={AI_INSTRUCTIONS_META} />
        <Meta />
        <Links />
      </head>
      <body className="min-h-screen antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

interface RootData {
  me: CurrentPrincipal | null;
  feedbackPending?: FeedbackPending | null;
  accessRequestsPending?: number | null;
}

export default function App() {
  return (
    <Shell data={useLoaderData() as RootData | undefined}>
      <Outlet />
    </Shell>
  );
}

// The chrome every page sits in, signed in or out: the one SiteHeader pinned
// on top, then the shell body. Signed in, Señor Doco's rail rides beside the
// page; below the shared two-column breakpoint it floats over the page
// instead, so the page never gets squeezed into a sliver next to the rail.
function Shell({ data, children }: { data: RootData | undefined; children: React.ReactNode }) {
  const me = data?.me ?? null;
  const mainRef = useMainScrollRestoration();
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SiteHeader
        me={me}
        feedbackPending={data?.feedbackPending ?? null}
        accessRequestsPending={data?.accessRequestsPending ?? 0}
      />
      <div className="doco-shell-body flex min-h-0 flex-1">
        {me ? <AgentSidebar me={me} /> : null}
        <main ref={mainRef} className="doco-shell-main min-w-0 flex-1 overflow-y-auto">
          {children}
        </main>
        {me ? <FeedbackReporter /> : null}
      </div>
    </div>
  );
}

function useMainScrollRestoration() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const mainRef = useRef<HTMLElement>(null);
  const restorerRef = useRef<ReturnType<typeof createMainScrollRestorer> | null>(null);

  if (!restorerRef.current) {
    restorerRef.current = createMainScrollRestorer();
  }

  // In-place navigations (a confirm-form reveal, a list filter) carry
  // `state: { preventScrollReset: true }` so the restorer keeps the pane put
  // instead of jumping to the top. The built-in <ScrollRestoration> reads React
  // Router's own preventScrollReset, but this main-pane restorer can't, so we
  // thread the intent through history state.
  const preventReset =
    (location.state as { preventScrollReset?: boolean } | null)?.preventScrollReset === true;

  useLayoutEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    restorerRef.current?.applyNavigation({
      element,
      key: location.key,
      navigationType,
      preventReset,
    });
  }, [location.key, navigationType, preventReset]);

  useLayoutEffect(() => {
    const save = () => {
      const element = mainRef.current;
      if (!element) return;
      restorerRef.current?.saveCurrent(element);
    };

    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
    };
  }, []);

  return mainRef;
}

export function ErrorBoundary() {
  const data = useRouteLoaderData("root") as RootData | undefined;
  return (
    <Shell data={data}>
      <RouteError />
    </Shell>
  );
}

function RouteError() {
  const error = useRouteError();
  const location = useLocation();
  let message = "An error occurred.";
  let details: string | null = null;
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    if (error.status === 403 && isAccessDeniedData(error.data)) {
      return (
        <AccessDeniedView data={error.data} currentPath={location.pathname + location.search} />
      );
    }
    message = `${error.status} ${error.statusText}`;
    details = typeof error.data === "string" ? error.data : JSON.stringify(error.data, null, 2);
  } else if (error instanceof Error) {
    message = error.message;
    stack = error.stack;
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="rounded-lg border border-destructive bg-card p-5">
        <h1 className="text-base font-semibold text-destructive">{message}</h1>
        {details ? <pre className="mt-2 text-xs text-muted-foreground">{details}</pre> : null}
        {stack ? (
          <pre className="mt-3 overflow-auto text-xs text-muted-foreground">{stack}</pre>
        ) : null}
      </div>
    </div>
  );
}

export function meta() {
  return [{ title: "Doco" }];
}
