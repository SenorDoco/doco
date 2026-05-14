// Server-only business logic for the "Create as agent" Doco onboarding flow.
// Imported by both onboarding.create.agent.tsx (HTML route) and
// onboarding.create.agent[.]json.tsx (JSON route).
//
// Lives in a `.server.ts` file (not a route module) so the bundler treats
// it as server-only — routes that re-export server logic alongside their
// client component end up dragging server-only deps into the client bundle.
import type { EntityId } from "@doco/shared";
import { validateDocoSlug } from "@doco/shared";
import { CANONICAL_INSTRUCTIONS } from "@doco/api";
import { rootDir } from "./db.server";
import { TokenStore } from "./tokens.server";
import { addAgentPrincipal, createDocoInHost, reindex } from "./redeem.server";
import { getOrCreateHostBootstrap, HOST_BOOTSTRAP_USERNAME } from "./bootstrap.server";

export type CreateAgentResult =
  | { error: string }
  | {
      ok: {
        doco_url: string;
        doco_slug: string;
        session_token: string;
        claim_url: string;
        claim_status_url: string;
        claim_expires_at: string;
        principal: { id: string; username: string; display_name: string };
        // Base protocol — query indicator at top, footer_lines after writes,
        // tally at last line. Same text the SessionStart hook injects on
        // every subsequent session.
        canonical_instructions: string;
        // Claim-specific OVERLAY on top of canonical_instructions. Only
        // the bits unique to an unclaimed Doco — claim reminder above the
        // canonical tally, plus the first-time scope-setup nudge.
        agent_instructions: {
          claim_reminder: string;
          claim_reminder_template: string;
          claim_detection: string;
          status_url: string;
          scope_setup: string;
          scope_setup_url: string;
          watched_explainer: string;
          scope_population: string;
        };
      };
    };

/**
 * Shared business logic for "create a Doco as an agent." Called from
 * the HTML action (renders the success page) and from the sibling
 * resource route `/onboarding/create/agent.json` (returns raw JSON).
 */
export async function createDocoAsAgentFromForm({
  form,
  baseUrl,
}: {
  form: FormData;
  baseUrl: string;
}): Promise<CreateAgentResult> {
  const root = rootDir();
  const docoSlug = String(form.get("doco_slug") ?? "").trim().toLowerCase();
  const description = String(form.get("description") ?? "").trim();
  const visibility = String(form.get("visibility") ?? "private") as "private" | "public";
  const agentDisplayName = String(form.get("agent_display_name") ?? "").trim() || "my-agent";
  const model = String(form.get("model") ?? "").trim() || "unknown";
  const provider = String(form.get("provider") ?? "").trim() || "unknown";

  if (!docoSlug) {
    return { error: "Doco slug is required." };
  }
  const slugError = validateDocoSlug(docoSlug);
  if (slugError) return { error: slugError };

  const bootstrap = getOrCreateHostBootstrap(root);

  // Anonymous flow: the caller can't see other host-bootstrap Docos at
  // creation time and shouldn't be told one exists at the requested
  // slug. Auto-suffix silently on collision; downstream URL building
  // uses the actually-used slug from the returned record (per intent
  // `private-docos-actually-private`).
  let docoRec: { docoId: string; path: string; docoSlug: string };
  try {
    const created = await createDocoInHost(root, {
      ownerSlug: HOST_BOOTSTRAP_USERNAME,
      docoSlug,
      ...(description ? { description } : {}),
      visibility,
      autoSuffixOnCollision: true,
    });
    docoRec = { docoId: created.docoId, path: created.path, docoSlug: created.docoSlug };
  } catch (e) {
    return { error: `Failed to create Doco: ${(e as Error).message}` };
  }
  await reindex(docoRec.path);

  const isoNow = new Date().toISOString();
  const agentUsername = `${HOST_BOOTSTRAP_USERNAME}/${isoNow}`;
  let agentId: EntityId<"principal">;
  try {
    agentId = await addAgentPrincipal(root, {
      username: agentUsername,
      display_name: agentDisplayName,
      owner_id: bootstrap.id,
      agent_metadata: {
        provider,
        model,
        capabilities: [],
        created_at: isoNow,
      },
    });
  } catch (e) {
    return { error: `Failed to create agent Principal: ${(e as Error).message}` };
  }

  const store = TokenStore.forDoco(root);
  const session = await store.issueSessionToken(agentId, bootstrap.id);
  const claim = await store.issueClaimToken(docoRec.docoId, agentId);
  const claimUrl = `${baseUrl}/claim/${claim.token}`;
  const claimStatusUrl = `${claimUrl}.json`;
  // Always use the slug the host returned — autoSuffixOnCollision may
  // have appended a number, in which case URLs/messages must match
  // what's actually on disk.
  const actualSlug = docoRec.docoSlug;

  return {
    ok: {
      doco_url: `${baseUrl}/${HOST_BOOTSTRAP_USERNAME}/${actualSlug}`,
      doco_slug: actualSlug,
      session_token: session.token,
      claim_url: claimUrl,
      claim_status_url: claimStatusUrl,
      claim_expires_at: claim.expires_at,
      principal: {
        id: agentId,
        username: agentUsername,
        display_name: agentDisplayName,
      },
      canonical_instructions: CANONICAL_INSTRUCTIONS,
      agent_instructions: {
        claim_reminder:
          "This Doco is unclaimed. Keep working — it's fully writable — but until claimed, render the claim reminder template ABOVE the canonical tally line on every user-facing message. Each render, replace the `<countdown>` placeholder with the time remaining until `claim_expires_at` formatted with the largest unit ≥ 1, rounded down: e.g. 'in 29 days', 'in 2 hours', 'in 5 minutes'. If past, render 'expired'. The canonical tally remains the absolute last line (per canonical_instructions §4). The canonical's top-of-reply query indicator is your connection heartbeat — you do NOT need a separate status footer.",
        claim_reminder_template: `[[🔮 Doco]](${claimUrl}) Claim this Doco: [${claimUrl}](${claimUrl}) — expires in <countdown>.`,
        claim_detection: `Read owner_slug from /<owner>/<doco>/search.json or /<owner>/<doco>/status.json — both responses carry it. While owner_slug === "${HOST_BOOTSTRAP_USERNAME}", keep emitting the claim reminder. When owner_slug flips to anything else, the Doco is claimed — drop the reminder. The canonical's top-of-reply search query already fetches this on every turn, so claim detection is free. The legacy ${claimStatusUrl} endpoint still works but is redundant.`,
        status_url: `${baseUrl}/${HOST_BOOTSTRAP_USERNAME}/${actualSlug}/status.json`,
        scope_setup:
          "STEP 1 of onboarding — set up scopes. DECIDE-AND-CONFIRM, not decide-and-execute. (1) Read the project (files, README, the description). (2) Propose a curated starter set to the project owner in plain prose: 'adrs' (architectural choices) + 'user-flows' (end-to-end journeys) + 1–2 CUSTOM scopes named for this project's actual subject areas (e.g. payments, search, content-schema). Ask them to confirm before materializing: 'For this project I'd start with adrs, user-flows, and a custom scope_<area> for <reason>. Sound right?' Then STOP and wait. (3) If the project is unclear, ASK FIRST — don't guess. Don't propose all eight built-in templates 'just in case' — adrs + user-flows + custom is the right starter shape; apis/bugs/runbooks/post-mortems/glossary/roadmap are available but the project owner adds them when the need arises. (4) Only after the project owner confirms, POST to /<owner>/<doco>/scopes/new or call the scope-creation endpoints. (5) During onboarding ONLY, pass watched=true on every scope you create — see watched_explainer below for what this means and why it's the onboarding default. (6) A single template scope alone is a smell — every onboarding session should produce at least one custom scope. NOTE: scope creation is STEP 1; do NOT stop after scopes exist — keep going to STEP 2 (scope_population).",
        scope_setup_url: `${baseUrl}/${HOST_BOOTSTRAP_USERNAME}/${actualSlug}/scopes/new?onboarding=1`,
        watched_explainer:
          "Every scope carries a 'watched' boolean (ADR-137bis). Watched=TRUE means contributors (project owner and agents alike) should proactively scan against this scope at capture time — 'does the thing I'm about to capture also belong here?' It's a soft attention signal, not enforcement. Watched=FALSE means the scope is available but no extra prompting; agents won't get nudged to consider it. During ONBOARDING, every scope you create defaults to watched=true: the project owner is literally in the room picking these scopes on purpose, so the attention signal matches what onboarding is for. After onboarding, ADR-137bis applies again — every scope-creation surface requires the caller (project owner or agent) to pick watched/not-watched explicitly with no default. The project owner can flip any scope's watched value any time from /<owner>/<doco>/scopes/<id>/edit. When you explain watched to the project owner in chat, use these exact words: 'Watched means: when you (or an agent) capture work later, this scope nudges you to consider whether the work belongs here.'",
        scope_population:
          "STEP 2 of onboarding — drive real content into each scope. ONBOARDING IS NOT DONE WHEN SCOPES EXIST. For EACH scope you just created, ask the project owner what they want to capture first: for adrs, 'What's the most important architectural choice you've already made that should be the first ADR?'; for user-flows, 'Walk me through the most important user journey in this project — I'll capture it as an Intent + Action chain'; for any custom scope, 'What's the load-bearing thing about <area> that's in your head but not in the repo yet?' Drive at least ONE real node into each scope before treating onboarding as complete. Empty scopes are the failure mode this step exists to prevent — a scope shell with no nodes is documentation theater, not the work. Only stop when EITHER (a) each scope has at least one real node, OR (b) the project owner explicitly says 'defer the rest for now' (acknowledge: 'OK, deferring; remember <scope_a>, <scope_b> are still empty and would benefit from a real node when you have a minute.'). NEVER print 'Onboarding done' if any scope is still empty unless (b) was said.",
      },
    },
  };
}
