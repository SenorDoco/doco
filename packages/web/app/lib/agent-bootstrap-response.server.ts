// Shared shape + prose for the two agent-bootstrap entry points:
//
//   POST /api/v1/docos.json                       (anonymous create)
//   POST /api/v1/invites/<code>/redeem.json       (invite redemption)
//
// Both flows hand an agent the same on-disk deliverable — DOCO_ACCESS
// in .env plus the four committed files (DOCO.md, AGENTS.md, CLAUDE.md,
// .gitignore entry) — and the same protocol in `canonical_instructions`.
// Only the source of DOCO_ACCESS differs (anonymous POST vs invite POST).
//
// IMPORTANT: the response intentionally bundles `canonical_instructions`,
// `scopes`, `constitution`, and `onboarding_overlay` inline. The agent
// MUST NOT need to hit `/api/v1/agent-bootstrap` right after redemption
// — a fresh-token + second-fetch-returning-instructions pattern trips
// agent-classifier credential-exfil heuristics. Bundling the protocol
// with the credential the user just authorized minting collapses the
// two calls into one.
//
// Putting the shape + prose in one place is the abstraction layer: a
// future change to a step name, the wording of the protocol-fetch
// instruction, or the structure of user_message_block automatically
// propagates to both flows. If the flows ever genuinely need to
// diverge on a step, branch on `flow` inside the relevant helper —
// don't fork the calling route.

import type { BootstrapContext } from "~/lib/bootstrap-context.server";
import { CANONICAL_INSTRUCTIONS } from "~/lib/instructions.server";

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
  /** Per-Doco bootstrap context (constitution, scopes manifest,
   *  onboarding overlay). Bundled so the agent does not need to make
   *  a follow-on /api/v1/agent-bootstrap call right after redemption.
   *  See the file header for why this matters. */
  context: BootstrapContext;
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
  /** The four-invariant protocol prose. Identical to what
   *  /api/v1/agent-bootstrap returns; bundled here so first-session
   *  agents don't need to make a second fetch. */
  canonical_instructions: string;
  /** Where deep-reference material lives — long-form walkthroughs the
   *  slim canonical points to. */
  reference_url: string;
  /** Per-Doco scope manifest at redemption time. Live scopes only;
   *  abandoned scopes omitted. */
  scopes: BootstrapContext["scopes"];
  /** Global scope + its authoring + guidance rules as of redemption.
   *  Null when the framework seed hasn't completed. */
  constitution: BootstrapContext["constitution"];
  /** Present when the Doco still only carries the framework-seeded
   *  Global scope. Agents in onboarding mode walk scope_setup +
   *  scope_population before treating onboarding as done. */
  onboarding_overlay: BootstrapContext["onboarding_overlay"];
}

// ---------------------------------------------------------------------------
// Step prose — edit ONE constant and both flows pick it up.
// ---------------------------------------------------------------------------

/** Steps that write project-local files. Identical for both flows. */
export const FILE_WRITE_STEPS: readonly string[] = [
  "Write DOCO_ACCESS=<doco_access> to ./.env (gitignored — create the file and add `.env` to .gitignore if either is missing).",
  "Write ./DOCO.md (committed, non-secret) with the doco_url near the top so future clones / CI / teammates' agents discover the Doco. If DOCO.md already exists, leave it alone.",
  "Update ./AGENTS.md to include `@./DOCO.md` near the top — if AGENTS.md is missing, write it. Don't replace existing AGENTS.md content; add the import line.",
  "Write ./CLAUDE.md with the single line `@./AGENTS.md` if it's missing. Claude Code auto-loads CLAUDE.md by name, which then pulls in AGENTS.md.",
];

/** Apply-protocol instruction. Identical for both flows. The protocol
 *  itself rides inline as `canonical_instructions` on this same
 *  response — the agent does NOT need to make a follow-on fetch
 *  right after redemption (which would trip credential-exfil
 *  heuristics). Subsequent sessions refresh via
 *  `node .agents/doco-agent-client.mjs bootstrap` or
 *  `GET /api/v1/agent-bootstrap` once they're past the wizard. */
export const PROTOCOL_FETCH_STEP =
  "Read the `canonical_instructions` field on this response — that's the protocol you must follow from your next reply onward. The four invariants live there. For later sessions, `node .agents/doco-agent-client.mjs bootstrap` (or `GET /api/v1/agent-bootstrap`) re-fetches the same prose, but you do NOT need to fetch it right now — it's already in your hands.";

/** Git-commit step. Identical for both flows. The "separate from Doco
 *  capture" framing is load-bearing — agents that conflate the two
 *  draw the "why push? you said it's in Doco" confusion from users.
 *  IMPORTANT: commit-wait does NOT stop the onboarding-overlay loop.
 *  If the project's rule says "don't commit unprompted", note that to
 *  the user as a one-liner and keep going — scope_setup and
 *  scope_population must still run while you wait for the commit nod. */
export const COMMIT_STEP =
  "Commit the bootstrap files to git (`DOCO.md`, `AGENTS.md`, `CLAUDE.md`, `.gitignore`). This is a SEPARATE action from Doco node capture — capture moved nodes onto doco.to; this commit lands files in the repo so future clones discover the Doco. Name the distinction when you tell the user. If you don't know the project's git workflow, ASK before pushing — but DO NOT let commit-wait stop the onboarding-overlay loop above. Keep running scope_setup + scope_population while the commit nod is pending.";

/** Run-onboarding-overlay step. Only meaningful for the create flow
 *  (and for redeem flows that hit a still-onboarding Doco) — the
 *  response carries `onboarding_overlay` which the agent must actually
 *  walk before treating the bootstrap as done. The agent stops short
 *  if it doesn't see an explicit step pointing at the overlay. */
export const ONBOARDING_OVERLAY_STEP =
  "Check the `onboarding_overlay` field on this response. If it's non-null, this Doco is still in onboarding — your very next visible action AFTER the GATE block above is to (a) render the two-path question from `onboarding_overlay.scope_setup` verbatim and wait for the project owner's answer, then (b) walk `onboarding_overlay.scope_population` (the per-scope checklist + read-propose-confirm-capture loop). DO NOT stall here just because the commit step below is waiting for a nod — onboarding-overlay work runs in parallel with commit-wait, not after it.";

/** user_message_block render instruction. Same final action — branch
 *  on flow only for the emphasis: create is a hard GATE because the
 *  invite expires in 7 days; redeem is a confirmation because the
 *  recipient already has access. Both branches share two anti-patterns
 *  the prose calls out: no preface ("the block IS the gate; surrounding
 *  narration weakens it"), and no duplicate file-list summary
 *  underneath ("the project owner already saw the tool diffs"). */
function renderUserMessageStep(flow: BootstrapFlow): string {
  const sharedAntiPatterns =
    " Render the block with NO preface — do NOT introduce it with prose like 'Now rendering the verbatim block (this is a GATE per the protocol):'. The block IS the gate; surrounding narration weakens it. After the block, do NOT re-list the files you just wrote in a 'Summary of what changed locally' section — the project owner already saw them in the tool diffs above, and a summary AFTER the block pushes the invite URL off the bottom of their viewport.";
  return flow === "create"
    ? `**GATE** — render the response's \`user_message_block\` verbatim to the user as your next message, BEFORE any other onboarding step. The block carries the invite URL the user must claim within 7 days or they lose web access to their own project's Doco. Don't paraphrase, don't bury, don't skip.${sharedAntiPatterns}`
    : `Render the response's \`user_message_block\` verbatim to whoever pasted the invite URL — confirms the connection and names what's now in .env.${sharedAntiPatterns}`;
}

/** Build the ordered checklist returned as `next_steps_for_agent`.
 *  Centralising it here means the create flow benefits whenever the
 *  redeem flow's checklist grows a step (and vice versa).
 *
 *  Order rationale: file writes → GATE → onboarding overlay walk →
 *  protocol fetch (already in hand) → commit. The GATE comes BEFORE
 *  the commit-wait so the invite URL lands in the user's hands first,
 *  and the onboarding-overlay step comes BEFORE commit so the agent
 *  doesn't treat the commit-wait as a stop signal that swallows
 *  scope_setup and scope_population.
 *
 *  `hasOnboardingOverlay` controls whether the overlay-walk step is
 *  included. Always true for create (a brand-new Doco only carries
 *  the framework-seeded `#global`). For redeem it's true only when
 *  the joined Doco is still in onboarding — on a mature Doco with
 *  populated scopes, the step is a no-op that still nudges the agent
 *  toward unwanted scope-setup conversation. Drop it. */
export function buildNextStepsForAgent(
  flow: BootstrapFlow,
  hasOnboardingOverlay: boolean,
): string[] {
  const steps: string[] = [...FILE_WRITE_STEPS, renderUserMessageStep(flow)];
  if (hasOnboardingOverlay) {
    steps.push(ONBOARDING_OVERLAY_STEP);
  }
  steps.push(PROTOCOL_FETCH_STEP);
  steps.push(COMMIT_STEP);
  return steps;
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
    `✅ Accepted the invite to **${handle}** (Doco at ${docoUrl}).`,
    ``,
    `Personal Doco access credential saved to \`./.env\` (gitignored). From here I fetch the protocol on session start, search prior decisions before drafting new ones, and capture meaningful changes as Doco nodes.`,
    ``,
    `The credential is mine alone — if you want your own access (browse the Doco on the web, mint invites for teammates), ask me for a fresh invite URL.`,
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
  const { flow, origin, doco, accessToken, invite, context } = input;
  const docoUrl = `${origin}/${doco.handle}/`;
  const next_steps_for_agent = buildNextStepsForAgent(
    flow,
    context.onboarding_overlay !== null,
  );
  const user_message_block = buildUserMessageBlock(flow, docoUrl, doco.handle, invite);
  const base: BootstrapResponse = {
    doco_id: doco.id,
    doco_handle: doco.handle,
    doco_url: docoUrl,
    doco_access: accessToken,
    next_steps_for_agent,
    user_message_block,
    canonical_instructions: CANONICAL_INSTRUCTIONS,
    reference_url: "/api/v1/agent-reference",
    scopes: context.scopes,
    constitution: context.constitution,
    onboarding_overlay: context.onboarding_overlay,
  };
  if (invite) {
    base.invite_url = invite.url;
    base.invite_expires_at = invite.expires_at;
  }
  return base;
}
