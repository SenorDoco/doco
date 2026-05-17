// Shared guidance text for "this Doco doesn't exist on this host" and
// "this Doco exists but your credentials don't grant access." Both are
// dead ends today — bare 404s with no next step — and the right
// recovery is wildly different between them (create-new vs ask-for-
// access). Conflating them is exactly the failure mode the user flagged:
// telling an inaccessible-but-real-Doco caller to `doco login --create`
// would fork a new Doco when the real one is right there.
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
          label: "Create a new Doco for this project",
          command: `doco login --host ${host} --create <slug>`,
          explainer:
            "Opens the browser-authorize flow and creates a Doco under your account. Pick a kebab-case slug naming the project. The CLI writes the Doco URL to doco.md and writes DOCO_ACCESS to .env.",
        },
        {
          label: "Recover the right id for an existing Doco",
          explainer:
            "Check the Doco URL in doco.md — typo? wrong host? If the URL is correct as written, ask the project owner for a fresh invite URL.",
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
      "Your access credential resolves to a principal that isn't the Doco's owner or a member of the owning org.",
    actions: [
      {
        label: "Ask the project owner to grant access",
        explainer:
          "The project owner controls the membership list and can add you from the Doco's settings page.",
      },
      {
        label: "Re-authorize with the right account",
        command: `doco login --host ${host}`,
        explainer:
          "Mints a fresh access credential. If you have access under a different account or organization, switch to that one in the browser flow.",
      },
      {
        label: "Do NOT run `doco login --create`",
        explainer:
          "That would fork a NEW Doco alongside this one — graph fragmentation. The Doco you want is already here; you just can't reach it yet.",
      },
    ],
  };
}

/**
 * Single-line summary suitable for the bootstrap response's `warning`
 * field — agents inject this into their `[🔮 Doco] Not connected yet:`
 * disconnected indicator, so it needs to fit on one logical line and
 * still carry the key command.
 */
export function formatMissingDocoLine(g: MissingDocoGuidance): string {
  const first = g.actions[0];
  if (!first) return g.title;
  const cmd = first.command ? ` Run: \`${first.command}\`` : "";
  const secondary = g.actions[1];
  const tail =
    secondary && secondary.command
      ? ` Or: \`${secondary.command}\`.`
      : secondary
        ? ` Or: ${secondary.label.toLowerCase()}.`
        : "";
  return `${g.title} ${first.label}.${cmd}.${tail}`.replace(/\.+/g, ".");
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
  return lines.join("\n").trimEnd() + "\n";
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
