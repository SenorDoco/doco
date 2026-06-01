// Internal-process equivalent of `fetch(localhost-url)` for the in-page
// agent. Same code path as an HTTP request — we just skip the socket.
//
// Rationale: Señor Doco's `doco_api` tool used to do `fetch()` against
// `localhost:PORT/<handle>/api/...`. Every call paid HTTP overhead:
// socket setup, request serialization, server-side parse, response
// serialization, fetch-side parse. On localhost that's typically
// 5-30ms per call before any real work. For a turn with several
// sequential tool calls that adds up.
//
// CRITICAL design property: this module MUST NOT reimplement any
// loader / action logic. It calls the same module exports — the same
// loader / action functions — that the React Router server would
// invoke for the equivalent HTTP request. If you find yourself
// copying business logic in here, you're doing it wrong. The
// contract: "external API and internal API are the same code paths;
// only the transport differs."
//
// Coverage: this module registers every API-shaped route the agent
// might call. Anything not registered falls back to HTTP fetch
// (signaled by `internalFetch` returning `null`). The fallback is a
// belt + suspenders for routes added later that haven't been wired
// in here yet — they still work, just at HTTP speed.

import { matchPath } from "react-router";

/**
 * Lazy module loaders for each API-shaped route. The pattern strings
 * mirror what `routes.ts` registers — the file paths point at the
 * same route module files HTTP requests reach. Registry is a flat
 * list rather than a tree because matching here is a single
 * shallow-path lookup (no nested layouts to traverse).
 *
 * Order matters: more specific patterns must come before less
 * specific ones (e.g. `principals.json` before `:type.json`). React
 * Router uses a scored matcher; we mimic the same ordering by
 * listing static segments first, parameterised segments last.
 */
interface RouteEntry {
  pattern: string;
  load: () => Promise<RouteModule>;
}

// Route modules each declare their own narrow `params` shape, so we
// can't constrain the loader/action types here without TypeScript
// fighting every entry. The runtime contract is unchanged — pass an
// object with `request` and `params`; React Router doesn't care that
// our dispatched param keys are typed loosely.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type RouteHandler = (args: { request: Request; params: any }) => Promise<Response>;

interface RouteModule {
  loader?: RouteHandler;
  action?: RouteHandler;
}

const ROUTES: RouteEntry[] = [
  // Host-wide v1 endpoints (no doco-handle prefix).
  {
    pattern: "/api/v1/agent-bootstrap.json",
    load: () => import("~/routes/api.v1.agent-bootstrap[.]json"),
  },
  { pattern: "/api/v1/docos.json", load: () => import("~/routes/api.v1.docos[.]json") },
  { pattern: "/api/v1/orgs.json", load: () => import("~/routes/api.v1.orgs[.]json") },
  {
    pattern: "/api/v1/me/preferences.json",
    load: () => import("~/routes/api.v1.me.preferences[.]json"),
  },
  {
    pattern: "/api/v1/feedback-reports.json",
    load: () => import("~/routes/api.v1.feedback-reports[.]json"),
  },
  {
    pattern: "/api/v1/users/invite.json",
    load: () => import("~/routes/api.v1.users.invite[.]json"),
  },
  {
    pattern: "/api/v1/api-keys.json",
    load: () => import("~/routes/api.v1.api-keys[.]json"),
  },
  {
    pattern: "/api/v1/docos/:docoId.json",
    load: () => import("~/routes/api.v1.docos.$docoId[.]json"),
  },
  // Agent-chat endpoints — exposed for completeness but the agent
  // itself shouldn't recurse into them.
  {
    pattern: "/api/v1/agent-chat/conversation.json",
    load: () => import("~/routes/api.v1.agent-chat.conversation[.]json"),
  },
  {
    pattern: "/api/v1/agent-chat/conversations.json",
    load: () => import("~/routes/api.v1.agent-chat.conversations[.]json"),
  },
  {
    pattern: "/api/v1/agent-chat/conversation/:id.json",
    load: () => import("~/routes/api.v1.agent-chat.conversation.$id[.]json"),
  },
  {
    pattern: "/api/v1/agent-chat/messages.json",
    load: () => import("~/routes/api.v1.agent-chat.messages[.]json"),
  },
  {
    pattern: "/api/v1/agent-chat/attachments.json",
    load: () => import("~/routes/api.v1.agent-chat.attachments[.]json"),
  },
  {
    pattern: "/api/v1/agent-chat/attachments/:attachmentId",
    load: () => import("~/routes/api.v1.agent-chat.attachments.$attachmentId"),
  },

  // Per-doco endpoints. Specific patterns first; the generic
  // `:type.json` dispatcher is last so the static ones win.
  {
    pattern: "/:docoHandle/status.json",
    load: () => import("~/routes/$docoHandle.status[.]json"),
  },
  {
    pattern: "/:docoHandle/search.json",
    load: () => import("~/routes/$docoHandle.search[.]json"),
  },
  {
    pattern: "/:docoHandle/graph-node-details.json",
    load: () => import("~/routes/$docoHandle.graph-node-details[.]json"),
  },
  {
    pattern: "/:docoHandle/graph-edge-details.json",
    load: () => import("~/routes/$docoHandle.graph-edge-details[.]json"),
  },
  {
    pattern: "/:docoHandle/api/project-tokens.json",
    load: () => import("~/routes/$docoHandle.api.project-tokens[.]json"),
  },
  {
    pattern: "/:docoHandle/api/github.json",
    load: () => import("~/routes/$docoHandle.api.github[.]json"),
  },
  {
    pattern: "/:docoHandle/api/principals.json",
    load: () => import("~/routes/$docoHandle.api.principals[.]json"),
  },
  {
    pattern: "/:docoHandle/api/principals/:id.json",
    load: () => import("~/routes/$docoHandle.api.principals.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/settings.json",
    load: () => import("~/routes/$docoHandle.api.settings[.]json"),
  },
  {
    pattern: "/:docoHandle/api/audit.json",
    load: () => import("~/routes/$docoHandle.api.audit[.]json"),
  },
  {
    pattern: "/:docoHandle/api/invites.json",
    load: () => import("~/routes/$docoHandle.api.invites[.]json"),
  },
  {
    pattern: "/:docoHandle/api/perspectives.json",
    load: () => import("~/routes/$docoHandle.api.perspectives[.]json"),
  },
  {
    pattern: "/:docoHandle/api/policies.json",
    load: () => import("~/routes/$docoHandle.api.policies[.]json"),
  },
  {
    pattern: "/:docoHandle/api/authoring-contract.json",
    load: () => import("~/routes/$docoHandle.api.authoring-contract[.]json"),
  },
  {
    pattern: "/:docoHandle/api/changesets.json",
    load: () => import("~/routes/$docoHandle.api.changesets[.]json"),
  },
  {
    pattern: "/:docoHandle/api/edges.json",
    load: () => import("~/routes/$docoHandle.api.edges[.]json"),
  },
  {
    pattern: "/:docoHandle/api/edges/:id.json",
    load: () => import("~/routes/$docoHandle.api.edges.$id[.]json"),
  },
  // Per-type-id routes — one entry per type because each lives in
  // its own file with its own custom loader/action.
  {
    pattern: "/:docoHandle/api/decisions/:id.json",
    load: () => import("~/routes/$docoHandle.api.decisions.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/intents/:id.json",
    load: () => import("~/routes/$docoHandle.api.intents.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/rules/:id.json",
    load: () => import("~/routes/$docoHandle.api.rules.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/actions/:id.json",
    load: () => import("~/routes/$docoHandle.api.actions.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/logs/:id.json",
    load: () => import("~/routes/$docoHandle.api.logs.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/evals/:id.json",
    load: () => import("~/routes/$docoHandle.api.evals.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/ideas/:id.json",
    load: () => import("~/routes/$docoHandle.api.ideas.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/states/:id.json",
    load: () => import("~/routes/$docoHandle.api.states.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/references/:id.json",
    load: () => import("~/routes/$docoHandle.api.references.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/guidance_policies/:id.json",
    load: () => import("~/routes/$docoHandle.api.guidance_policies.$id[.]json"),
  },
  {
    pattern: "/:docoHandle/api/node_authoring_policies/:id.json",
    load: () => import("~/routes/$docoHandle.api.node_authoring_policies.$id[.]json"),
  },
  // Generic dispatchers — LAST so the more specific routes above win.
  {
    pattern: "/:docoHandle/api/:type.json",
    load: () => import("~/routes/$docoHandle.api.$type[.]json"),
  },
  {
    pattern: "/:docoHandle/api/:type.txt",
    load: () => import("~/routes/$docoHandle.api.$type[.]txt"),
  },
];

export interface InternalFetchRouteMatch {
  pattern: string;
  params: Record<string, string>;
}

function matchInternalRoute(
  pathname: string,
): { entry: RouteEntry; params: Record<string, string> } | null {
  for (const entry of ROUTES) {
    const m = matchPath(entry.pattern, pathname);
    if (!m) continue;
    return { entry, params: m.params as Record<string, string> };
  }
  return null;
}

export function getInternalFetchRouteMatch(path: string): InternalFetchRouteMatch | null {
  const [pathname] = path.split("?", 2);
  const matched = matchInternalRoute(pathname);
  if (!matched) return null;
  return { pattern: matched.entry.pattern, params: matched.params };
}

interface InternalFetchInput {
  method: string;
  /** Path with leading "/". Query string is preserved. */
  path: string;
  /** Origin for the synthetic Request's URL — should match the caller's. */
  origin: string;
  /** Cookie header forwarded verbatim so the session lookup works. */
  cookieHeader: string;
  /** Optional JSON body for POST/PATCH/DELETE. Strings sent as-is. */
  body?: unknown;
  /** Optional user-agent to mark internal calls in logs. */
  userAgent?: string;
  /** Optional authoring surface propagated into capture/history metadata. */
  authoringSurface?: string;
}

/**
 * Try to handle the call in-process. Returns the same Response shape
 * an HTTP fetch would produce — so callers can drop this in front of
 * an existing fetch path without changing downstream logic.
 *
 * Returns `null` when no registered route matches (caller should fall
 * back to HTTP fetch). Throws only if the matched module's loader /
 * action itself throws.
 */
export async function internalFetch(input: InternalFetchInput): Promise<Response | null> {
  // Split off the search component so matchPath sees only the
  // pathname — query parameters are preserved on the Request's URL.
  const [pathname, search = ""] = input.path.split("?", 2);

  const matched = matchInternalRoute(pathname);
  if (!matched) return null;

  const module = await matched.entry.load();
  const method = input.method.toUpperCase();
  const handler =
    method === "GET" || method === "HEAD" ? module.loader : (module.action ?? module.loader);
  if (!handler) {
    return Response.json(
      { error: `Internal route ${matched.entry.pattern} has no handler for ${method}.` },
      { status: 405 },
    );
  }

  // Build a Request that looks indistinguishable from an HTTP one.
  // The route's loader/action and any middleware downstream (auth,
  // doco-access, telemetry) read from this Request; passing it the
  // real Cookie header is how the session is recovered.
  const url = new URL(pathname + (search ? `?${search}` : ""), input.origin).toString();
  const headers = new Headers({
    Cookie: input.cookieHeader,
    Accept: "application/json",
    "User-Agent": input.userAgent ?? "Doco-Internal-Fetch/1",
  });
  if (input.authoringSurface) {
    headers.set("X-Doco-Authoring-Surface", input.authoringSurface);
  }
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD" && input.body !== undefined) {
    headers.set("Content-Type", "application/json");
    init.body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
  }
  // React Router loaders / actions throw Response objects to signal
  // non-2xx outcomes (404, 401, redirects). Without this catch, the
  // throw bubbles into the agent-chat catch block where
  // `err instanceof Error` is false, producing the useless
  // `fetch failed: [object Response]` toString. Mirror RR's own
  // behavior — a thrown Response IS the response.
  try {
    return await handler({ request: new Request(url, init), params: matched.params });
  } catch (err) {
    if (err instanceof Response) return err;
    throw err;
  }
}

/** Exposed for tests / diagnostics — list every route the internal
 *  fast path can serve. */
export function listInternalRoutes(): string[] {
  return ROUTES.map((r) => r.pattern);
}
