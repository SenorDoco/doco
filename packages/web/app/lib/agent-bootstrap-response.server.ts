// Shared shape + prose for the two agent-bootstrap entry points:
//
//   POST /api/v1/docos.json                       (anonymous create)
//   POST /api/v1/invites/<code>/redeem.json       (invite redemption)
//
// Both flows hand an agent the same on-disk deliverable — DOCO_ACCESS
// in .env plus the four committed files (doco.md, AGENTS.md, CLAUDE.md,
// .gitignore entry) — and the same protocol-fetch instruction. Only
// the source of DOCO_ACCESS differs (anonymous POST vs invite POST).
//
// Putting the shape + prose in one place is the abstraction layer: a
// future change to a step name, the wording of the protocol-fetch
// instruction, or the structure of user_message_block automatically
// propagates to both flows. If the flows ever genuinely need to
// diverge on a step, branch on `flow` inside the relevant helper —
// don't fork the calling route.

export type BootstrapFlow = "create" | "redeem";

/**
 * Optional handoff invite the response carries to the agent so the
 * agent can paste a "claim your access" URL to its user. Always
 * present on `create`; opt-in on `redeem` (rare path — see the
 * invite-already-consumed UX in /onboarding/join/agent.txt).
 */
export interface BootstrapInviteHandoff {
  url: string;
  /** ISO timestamp the invite expires. */
  expires_at: string;
}

export interface BuildBootstrapResponseInput {
  flow: BootstrapFlow;
  /** Origin like `https://doco.to` — caller is responsible for
   *  stripping any trailing slash. */
  origin: string;
  doco: { id: string; handle: string };
  /** The `DOCO_ACCESS` value the agent must write to ./.env. */
  accessToken: string;
  /** Present iff the response should hand the agent an invite URL. */
  invite?: BootstrapInviteHandoff;
}

export interface BootstrapResponse {
  doco_id: string;
  doco_handle: string;
  doco_url: string;
  doco_access: string;
  invite_url?: string;
  invite_expires_at?: string;
  next_steps_for_agent: string[];
  user_message_block: string;
}

// ---------------------------------------------------------------------------
// Step prose — edit ONE constant and both flows pick it up.
// ---------------------------------------------------------------------------

/** Steps that write project-local files. Identical for both flows. */
export const FILE_WRITE_STEPS: readonly string[] = [
  "Write DOCO_ACCESS=<doco_access> to ./.env (gitignored — create the file and add `.env` to .gitignore if either is missing).",
  "Write ./doco.md (committed, non-secret) with the doco_url near the top so future clones / CI / teammates' agents discover the Doco. If doco.md already exists, leave it alone.",
  "Update ./AGENTS.md to include `@./doco.md` near the top — if AGENTS.md is missing, write it. Don't replace existing AGENTS.md content; add the import line.",
  "Write ./CLAUDE.md with the single line `@./AGENTS.md` if it's missing. Claude Code auto-loads CLAUDE.md by name, which then pulls in AGENTS.md.",
];

/** Protocol-fetch instruction. Identical for both flows. */
export const PROTOCOL_FETCH_STEP =
  "Fetch the canonical protocol: prefer `node .agents/doco-agent-client.mjs bootstrap` when the repo has the helper; otherwise GET https://doco.to/api/v1/agent-bootstrap with `Authorization: Bearer ${DOCO_ACCESS}`. Apply it from your next reply.";

/** Git-commit step. Identical for both flows. The "separate from Doco
 *  capture" framing is load-bearing — agents that conflate the two
 *  draw the "why push? you said it's in Doco" confusion from users. */
export const COMMIT_STEP =
  "Commit the bootstrap files to git (`doco.md`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`). This is a SEPARATE action from Doco node capture — capture moved nodes onto doco.to; this commit lands files in the repo so future clones discover the Doco. Name the distinction when you tell the user. If you don't know the project's git workflow, ASK before pushing.";

/** user_message_block render instruction. Same final action — branch
 *  on flow only for the emphasis: create is a hard GATE because the
 *  invite expires in 7 days; redeem is a confirmation because the
 *  recipient already has access. */
function renderUserMessageStep(flow: BootstrapFlow): string {
  return flow === "create"
    ? "**GATE** — render the response's `user_message_block` verbatim to the user as your next message, BEFORE scope work or any other onboarding step. The block carries the invite URL the user must claim within 7 days or they lose web access to their own project's Doco. Don't paraphrase, don't bury, don't skip."
    : "Render the response's `user_message_block` verbatim to whoever pasted the invite URL — confirms the connection and names what's now in .env.";
}

/** Build the ordered checklist returned as `next_steps_for_agent`.
 *  Centralising it here means the create flow benefits whenever the
 *  redeem flow's checklist grows a step (and vice versa). */
export function buildNextStepsForAgent(flow: BootstrapFlow): string[] {
  return [
    ...FILE_WRITE_STEPS,
    PROTOCOL_FETCH_STEP,
    COMMIT_STEP,
    renderUserMessageStep(flow),
  ];
}

// ---------------------------------------------------------------------------
// user_message_block — flow-specific because the asymmetric stakes
// (claim-within-7-days vs already-connected) genuinely produce
// different prose.
// ---------------------------------------------------------------------------

function buildCreateUserMessage(docoUrl: string, invite: BootstrapInviteHandoff): string {
  const expiresHuman = new Date(invite.expires_at).toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short",
  });
  return [
    `✅ I created a Doco for this project at **${docoUrl}**.`,
    ``,
    `🤝 **Important — claim your collaboration access within 7 days.**`,
    `Open this invite URL in your browser and sign in with GitHub:`,
    ``,
    `**${invite.url}**`,
    ``,
    `Expires ${expiresHuman} UTC (single-use; once you accept, this URL stops working).`,
    ``,
    `If you don't claim, I'll keep operating directly via the API — but you won't be able to browse the Doco on the web, mint invite URLs for teammates, or revoke my access.`,
  ].join("\n");
}

function buildRedeemUserMessage(docoUrl: string, handle: string): string {
  return [
    `✅ I claimed access to **${handle}** (Doco at ${docoUrl}).`,
    ``,
    `I saved my personal Doco access credential to \`./.env\` (gitignored) — from here I fetch the protocol on session start, search prior decisions before drafting new ones, and capture meaningful changes as Doco nodes.`,
    ``,
    `If this repo didn't already have a \`doco.md\`, I just wrote one so future clones / CI / teammates discover the Doco. The access credential in \`.env\` is mine alone — if you want your own access (browse on the web, mint invites for teammates), ask me for a fresh invite URL.`,
  ].join("\n");
}

function buildUserMessageBlock(
  flow: BootstrapFlow,
  docoUrl: string,
  handle: string,
  invite?: BootstrapInviteHandoff,
): string {
  if (flow === "create") {
    if (!invite) {
      throw new Error("buildAgentBootstrapResponse: create flow requires invite handoff");
    }
    return buildCreateUserMessage(docoUrl, invite);
  }
  return buildRedeemUserMessage(docoUrl, handle);
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

/**
 * Build the JSON payload both onboarding endpoints return. Same shape
 * for both flows so client recipes (agent.txt, AGENTS.md prose, future
 * CLI affordances) can parse them uniformly.
 */
export function buildAgentBootstrapResponse(
  input: BuildBootstrapResponseInput,
): BootstrapResponse {
  const { flow, origin, doco, accessToken, invite } = input;
  const docoUrl = `${origin}/${doco.handle}/`;
  const next_steps_for_agent = buildNextStepsForAgent(flow);
  const user_message_block = buildUserMessageBlock(flow, docoUrl, doco.handle, invite);
  const base: BootstrapResponse = {
    doco_id: doco.id,
    doco_handle: doco.handle,
    doco_url: docoUrl,
    doco_access: accessToken,
    next_steps_for_agent,
    user_message_block,
  };
  if (invite) {
    base.invite_url = invite.url;
    base.invite_expires_at = invite.expires_at;
  }
  return base;
}
