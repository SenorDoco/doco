import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLoaderData,
  useLocation,
  useRouteError,
} from "react-router";

import { AccessDeniedView, isAccessDeniedData } from "~/components/access-denied-view";
import { AgentSidebar } from "~/components/agent-sidebar";
import { FeedbackReporter } from "~/components/feedback-reporter";
import { SiteHeader, SiteHeaderSuppressionProvider } from "~/components/site-header";
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
  // Signed-out: the anonymous landing + sign-in flow has its own header
  // chrome; let it render as-is.
  if (!me) {
    return <Outlet />;
  }
  // Signed-in chrome layout: top bar pinned, then a flex row with the
  // assistant sidebar (320 px, always visible) and the scrolling main
  // content. The outer div locks page height so the aside doesn't
  // scroll away with the rest of the body. We render SiteHeader here
  // once (shellOwner) and wrap the Outlet in SiteHeaderSuppressionProvider
  // so per-route <SiteHeader> calls (default shellOwner=false) render null.
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <SiteHeader mode="host" me={me} shellOwner />
      <div className="flex min-h-0 flex-1">
        <AgentSidebar me={me} />
        <main className="min-w-0 flex-1 overflow-y-auto">
          <SiteHeaderSuppressionProvider>
            <Outlet />
          </SiteHeaderSuppressionProvider>
        </main>
        <FeedbackReporter />
      </div>
    </div>
  );
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
