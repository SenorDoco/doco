// Shared guidance text for "this Doco doesn't exist on this host" and
// "this Doco exists but your credentials don't grant access." Both are
// dead ends today — bare 404s with no next step — and the right
// recovery is wildly different between them (create-new vs ask-for-
// access). Conflating them is exactly the failure mode the user flagged:
// telling an inaccessible-but-real-Doco caller to create a new Doco
// would fork one when the real one is right there.
//
// Three call sites consume this:
//   - /api/v1/agent-bootstrap     (warning field — single-line, agent reads)
//   - /by-id/<id>/...             (splat 404/403 body — plain text, curl reads)
//   - /api/v1/docos/<id>.json     (404/403 body — plain text, curl reads)
//
// On the bootstrap endpoint the bearer credential tells us which state the
// caller is in. On the splat / docos.json endpoints the caller may be
// anonymous, but we still de-conflate: ULIDs are 128-bit (effectively
// unguessable), so "this id exists but you can't see it" is not a
// meaningful enumeration vector.

export type MissingDocoState = "not_found" | "no_access";

export interface MissingDocoAction {
  /** Short label for UI buttons / list bullets. */
  label: string;
  /** Optional shell command the user can run verbatim. */
  command?: string;
  /** One-sentence explainer for what this action does. */
  explainer: string;
}

export interface MissingDocoGuidance {
  state: MissingDocoState;
  /** HTTP status the route should use for this state. */
  status: 404 | 403;
  /** One-sentence headline (used in bootstrap warning + at top of body). */
  title: string;
  /** Couple-sentence elaboration. */
  summary: string;
  /** Ordered list of recovery actions. */
  actions: MissingDocoAction[];
}

export function buildMissingDocoGuidance(args: {
  state: MissingDocoState;
  /** The identifier the caller used — a doco_<ulid> or Doco handle. */
  identifier: string;
  /** Host URL like "https://doco.to". */
  host: string;
}): MissingDocoGuidance {
  const { state, identifier, host } = args;
  if (state === "not_found") {
    return {
      state,
      status: 404,
      title: `No Doco "${identifier}" exists on ${host}.`,
      summary:
        "Either the id is wrong (typo, deleted, wrong host) or no Doco has been created yet under this id.",
      actions: [
        {
          label: "Create the Doco in the project's Workspace",
          explainer: `Every Doco lives in its project's Workspace, and people create Workspaces, never agents. If the project has none yet, ask the owner to create one at ${host}/new-workspace and grant you access to it as owner (all their workspaces, or that one workspace). Then create the Doco there yourself: doco_create over the MCP, or POST ${host}/api/v1/docos.json. Then put the Doco's URL in .doco/connections.md and authorize this checkout — connect via the MCP at ${host}/mcp, or set DOCO_ACCESS in .env from a token minted at ${host}/tokens.`,
        },
        {
          label: "Recover the right id for an existing Doco",
          explainer:
            "Check the Doco URL in .doco/connections.md — typo? wrong host? If the URL is correct as written, ask the project owner for a fresh invite URL.",
        },
      ],
    };
  }
  // no_access
  return {
    state,
    status: 403,
    title: `The Doco "${identifier}" exists on ${host}, but your credentials don't grant access.`,
    summary:
      "Your access credential resolves to a principal that isn't the Doco's owner or a member of the owning workspace.",
    actions: [
      {
        label: "Ask the project owner to grant access",
        explainer:
          "The project owner controls the membership list and can add you from the Doco's settings page.",
      },
      {
        label: "Re-authorize with the right account",
        explainer: `Mint a fresh access credential at ${host}/tokens, or reconnect the MCP at ${host}/mcp. If you have access under a different account or workspace, switch to that one in the browser flow.`,
      },
      {
        label: "Do NOT try to create a second Doco",
        explainer:
          "The Doco you want is already here; the fix is getting the right access, not creating a parallel Doco alongside it.",
      },
    ],
  };
}

/**
 * Multi-line plain-text guidance for HTTP response bodies (404 / 403)
 * that curl users and raw agents read directly. Formatted so the
 * actions read as a numbered checklist.
 */
export function formatMissingDocoText(g: MissingDocoGuidance): string {
  const lines: string[] = [g.title, "", g.summary, ""];
  g.actions.forEach((a, i) => {
    lines.push(`${i + 1}. ${a.label}`);
    if (a.command) lines.push(`     $ ${a.command}`);
    lines.push(`     ${a.explainer}`);
    lines.push("");
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Build a Response carrying the multi-line guidance with the right
 * HTTP status. Used by the splat and docos.json routes.
 */
export function missingDocoResponse(args: {
  state: MissingDocoState;
  identifier: string;
  host: string;
}): Response {
  const g = buildMissingDocoGuidance(args);
  return new Response(formatMissingDocoText(g), {
    status: g.status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** Convenience for callers that have a Request and want the host URL. */
export function hostFromRequest(request: Request): string {
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}
