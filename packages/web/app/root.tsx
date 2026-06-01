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
} from "react-router";

import { AccessDeniedView, isAccessDeniedData } from "~/components/access-denied-view";
import { AgentSidebar } from "~/components/agent-sidebar";
import { FeedbackReporter } from "~/components/feedback-reporter";
import { SiteHeader, SiteHeaderSuppressionProvider } from "~/components/site-header";
import { createMainScrollRestorer } from "~/lib/main-scroll-restoration";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session.server";
import "./app.css";

// Root loader — fetch the current Principal once so the persistent
// AgentSidebar in App() knows whether to render. Per-route loaders
// still fetch `me` themselves where they need it; we don't try to
// thread root data through context.
export async function loader({ request }: { request: Request }) {
  try {
    const me = await getCurrentPrincipal(request);
    return { me };
  } catch {
    return { me: null as CurrentPrincipal | null };
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
          Agent-discovery signals. Two layers, both pointing at /llms.txt:

            1. A natural-language meta tag any LLM reading the head sees first.
            2. A semantic `<link rel="alternate">` for agents that scan for
               structured pointers.

          Why on root.tsx and not just _index.tsx: an agent that lands on
          any internal page should see the same hint — not just the
          homepage. See routes/llms[.]txt.tsx for the why.
        */}
        <meta
          name="ai-instructions"
          content="This site is Doco — AI-native documentation for software projects. If you were told 'let's start using Doco' or similar, fetch /llms.txt for setup instructions."
        />
        <link rel="alternate" type="text/plain" title="LLM instructions" href="/llms.txt" />
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

export default function App() {
  const data = useLoaderData() as { me: CurrentPrincipal | null } | undefined;
  const me = data?.me ?? null;
  const mainRef = useMainScrollRestoration();
  // Signed-out: the anonymous landing + sign-in flow has its own header
  // chrome; let it render as-is.
  if (!me) {
    return <Outlet />;
  }
  // Signed-in chrome layout: top bar pinned, then a responsive shell
  // body. Below the shared two-column breakpoint, Señor Doco stacks
  // above the scrolling page content so the page never gets squeezed
  // into a sliver next to the rail. We render SiteHeader here once
  // (shellOwner) and wrap the Outlet in SiteHeaderSuppressionProvider
  // so per-route <SiteHeader> calls (default shellOwner=false) render null.
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SiteHeader me={me} shellOwner />
      <div className="doco-shell-body flex min-h-0 flex-1">
        <AgentSidebar me={me} />
        <main ref={mainRef} className="doco-shell-main min-w-0 flex-1 overflow-y-auto">
          <SiteHeaderSuppressionProvider>
            <Outlet />
          </SiteHeaderSuppressionProvider>
        </main>
        <FeedbackReporter />
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

  useLayoutEffect(() => {
    const element = mainRef.current;
    if (!element) return;
    restorerRef.current?.applyNavigation({ element, key: location.key, navigationType });
  }, [location.key, navigationType]);

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
    <main className="mx-auto max-w-2xl p-6">
      <div className="rounded-lg border border-destructive bg-card p-5">
        <h1 className="text-base font-semibold text-destructive">{message}</h1>
        {details ? <pre className="mt-2 text-xs text-muted-foreground">{details}</pre> : null}
        {stack ? (
          <pre className="mt-3 overflow-auto text-xs text-muted-foreground">{stack}</pre>
        ) : null}
      </div>
    </main>
  );
}

export function meta() {
  return [{ title: "Doco" }];
}
