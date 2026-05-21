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
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session";
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
  // The sidebar is 280px wide, fixed to the left edge below the top bar.
  // Sibling routes keep rendering their own SiteHeader; we only pad the
  // outlet so its content sits to the right of the sidebar when it's
  // visible. Signed-out users (sign-in / anonymous landing) see no
  // sidebar and no padding.
  return (
    <>
      {me ? <AgentSidebar me={me} /> : null}
      <div style={me ? { paddingLeft: 280 } : undefined}>
        <Outlet />
      </div>
    </>
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
