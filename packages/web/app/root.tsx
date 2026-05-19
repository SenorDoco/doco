import { getDocoByIdOrHandle } from "@doco/db";
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
import { ResizableChatRail } from "~/components/resizable-chat-rail";
import { SenorDocoChatPane } from "~/components/senor-doco-chat-pane";
import { SiteHeader, SiteHeaderSuppressionProvider } from "~/components/site-header";
import { getCurrentPrincipal, isHumanPrincipal } from "~/lib/session";
import "./app.css";

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
          /onboarding/create or any other page should see the same hint —
          not just the homepage. See routes/llms[.]txt.tsx for the why.
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
  const data = useLoaderData<typeof loader>();
  if (!data.docoChat) return <Outlet />;
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <SiteHeader
        mode="host"
        me={data.docoChat.me}
        docoScope={{ handle: data.docoChat.handle }}
        shellOwner
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <ResizableChatRail>
          <SenorDocoChatPane
            key={data.docoChat.handle}
            endpoint={data.docoChat.endpoint}
            handle={data.docoChat.handle}
          />
        </ResizableChatRail>
        <div className="min-w-0 flex-1 overflow-auto">
          <SiteHeaderSuppressionProvider>
            <Outlet />
          </SiteHeaderSuppressionProvider>
        </div>
      </div>
    </div>
  );
}

const HOST_LEVEL_PATHS = new Set([
  "agent",
  "ai",
  "api",
  "auth",
  "connect",
  "dashboard",
  "docs",
  "getting-started",
  "install",
  "invite",
  "llms.txt",
  "mcp",
  "new",
  "new-doco",
  "new-org",
  "onboarding",
  "orgs",
  "robots.txt",
  "setup",
  "sign-in",
  "sign-out",
  "sign-up",
  "users",
]);

const NON_HTML_DOCO_LEAVES = new Set(["chat.json", "search.json", "status.json"]);

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!isHumanPrincipal(me)) return { docoChat: null };
  const url = new URL(request.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const first = parts[0];
  if (!first || HOST_LEVEL_PATHS.has(first)) return { docoChat: null };
  if (parts[1] === "api" || NON_HTML_DOCO_LEAVES.has(parts[1] ?? "")) {
    return { docoChat: null };
  }
  const row = await getDocoByIdOrHandle(first).catch(() => null);
  if (!row) return { docoChat: null };
  return {
    docoChat: {
      handle: row.handle,
      endpoint: `/${row.handle}/chat.json`,
      me,
    },
  };
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
