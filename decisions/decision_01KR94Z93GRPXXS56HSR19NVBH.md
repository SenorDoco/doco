---
id: decision_01KR94Z93GRPXXS56HSR19NVBH
doco_id: doco_01KR441EA0ZDMF0N5DY38GSVS3
node_type: decision
schema_version: "0.1"
summary: "LLM-based scope suggestions on /scopes/new: server-side OpenAI call asks for project-specific scopes; templates relegated to shortcuts; custom input is primary."

slug: llm-scope-suggestions
number: "ADR-085"
follows:
  - decision_01KR8Y6VSVWHWB8MQNM5W9WJP2   # ADR-082 (purpose + guidelines + 8 templates)
  - decision_01KR8Z7YHJTEWP4QQZQ43MJMBQ   # ADR-084 (scope mgmt UX)
intent_ids:
  - intent_01KR441EAEM5NQBM160763TDDT
question: "ADR-082 shipped 8 default templates; ADR-084 made them checkboxes on /scopes/new. Real-world result: agents tick all 8 mindlessly because the UX presents them as the menu. Custom input was buried below as '(optional)'. The user's framing: prepopulate suggestions for what *this* project actually needs. How?"
chosen: |
  Three coordinated moves:

  ### 1. Reframe /scopes/new

  - Custom textarea is **primary** ("What do you want to document?"),
    autofocused, with diverse placeholder examples (`checkout-flow`,
    `country/france/payment`, `team/platform`, `migration/postgres-15`,
    `gdpr-compliance`).
  - Templates demoted to **"Or start with a common template"** with
    explicit copy: "Custom scopes above are equally valid; templates are
    just a head start."
  - Card description leads with: "Scopes are topical neighborhoods —
    anything you want to track separately. A scope can be a feature
    area, a country, a team, a customer segment, a regulatory regime,
    a document type, a migration project, anything."
  - Empty-state copy: "None yet. Type any names above — they can be
    anything."

  ### 2. LLM-based suggestions

  New top card "Suggest scopes for me" with a project-description
  textarea (prefilled from the Doco's `description`). Click "Suggest
  scopes" → POST to a new resource route `/api/suggest-scopes` →
  server-side fetch to OpenAI's chat completions API → returns
  `[{ name, purpose, guidelines, reasoning }, ...]`. UI renders each
  suggestion as a checkbox (default-checked) with name + purpose +
  italic "Why: <reasoning>". Hidden inputs carry `purpose` +
  `guidelines` through to the action so the created Scope lands with
  the LLM's prefilled metadata, not just a name.

  Prompt design (in `packages/api/src/llm.ts`):
  - System prompt teaches Doco's scope semantics (flat names, slash
    for hierarchy, edge-based parents) and required JSON shape.
  - Asks for 5-8 *project-specific* scopes — explicitly tells the
    model to avoid templates (user-flows, adrs, apis, bugs, runbooks,
    post-mortems, glossary, roadmap) and existing scope names.
  - `temperature: 0.5`, `model: gpt-4o-mini` (low latency + cost).

  ### 3. Graceful fallback

  `suggestScopes()` returns `[]` if `OPENAI_API_KEY` is missing, the
  call fails, the response is malformed, or the timeout (30s) trips.
  No throw, no error UI. The form remains fully functional via custom
  input + templates.

  When the key is missing, the user sees: "No suggestions returned.
  (LLM unavailable, or all proposals already exist or duplicate
  templates.) You can still type custom scopes below."

  ### Server-side, not client-side

  The OpenAI call lives in the server-side resource route, not the
  browser. Two reasons: the API key never leaves the host process;
  the key auto-loads from `.env` (see `loadDotEnvFromAncestors` in
  `llm.ts`) so any deploy target works without per-environment
  config rituals.

  ### Why this earns its keep

  Without it: 8-template form encourages the lazy "tick all" path.
  With it: an agent describes their project once → gets project-
  specific scopes with prefilled purpose + guidelines that match
  what they're documenting → ticks the relevant ones. The lazy
  fallback (templates) is still there for when no description is
  available.

  Verified end-to-end: a description like "A payment service for
  European merchants with PCI compliance, multi-currency support,
  per-country regulatory variants (France, Germany, Italy), and
  merchant onboarding flows. Plus a real-time fraud detection engine."
  produces 7 specific scopes — `payment_service`, `pci_compliance`,
  `fraud_detection`, `onboarding_flows`, `country/france`,
  `country/germany`, `country/italy`. Slash-paths auto-create the
  `country` parent through `materializeScopeTree`.

alternatives:
  - name: Client-side OpenAI call from the browser
    rejected_because: "Leaks the API key to every visitor. Server-side keeps secrets server-side."
  - name: Use embeddings instead — fetch existing scopes from similar projects and suggest those
    rejected_because: "No corpus yet. Cold-start makes embeddings useless. Generative-LLM works on day one with no prior data."
  - name: Make the LLM call required (block submit until suggestions land)
    rejected_because: "Hard dependency on a network service. Form must work offline + when key is missing. Suggestions are an enhancement, never a gate."
  - name: 20+ default templates instead of LLM
    rejected_because: "Decision fatigue. The 8 templates already overwhelm; doubling that doesn't help. LLM proposes scopes specific to *this* project, not generic ones."
  - name: Have the LLM also write the doco.yaml description
    rejected_because: "Premature. Today the human/agent supplies the description on /new-doco. If we later want richer auto-fill (e.g., from README contents), make it its own Phase."

rules_consulted:
  - rule_01KR441EAJCPF378ZGM9DMDFH0
decided_by: torrenegra
decided_at: 2026-05-10T08:00:00Z

created_at: 2026-05-10T08:00:00Z
created_by: claude-opus-4-7
revision: 1
lifecycle: active
status: accepted
scopes:
  - scope_01KR441EA37E3M5V0ZV6ZRB97D
  - scope_01KR441EA8BTTB99H928Z0NQQW
---

# ADR-085 — LLM-based scope suggestions

## Why

ADR-082 shipped 8 default templates; ADR-084 surfaced them as checkboxes
on `/scopes/new`. The first agent that hit the page in the wild ticked
all 8 templates blindly because the UX framed them as the menu, with
custom input buried below as "(optional)." Real outcome: a `my-project`
Doco with eight generic scopes that don't reflect what the project is
actually about.

The user's instinct: prepopulate. Have the system suggest scopes
specific to what's being built, not just present a fixed checklist.

## What ships

| change | where |
|---|---|
| `suggestScopes()` server-side OpenAI client | `packages/api/src/llm.ts` |
| `.env` walk-up + auto-load | `packages/api/src/llm.ts` (top-of-module) |
| Resource route `POST /api/suggest-scopes` | `packages/web/app/routes/api.suggest-scopes.tsx` |
| `/scopes/new` reframed: custom is primary, templates are shortcuts | `routes/$ownerSlug.$docoSlug.scopes.new.tsx` |
| "Suggest scopes for me" card with description input + Suggest button | same |
| Suggestions card with default-checked rows + reasoning | same |
| Canonical agent instructions: scopes are open-vocabulary | `packages/api/src/instructions.ts` |

## What's deferred

- **Auto-fill description from repo content** (README, package.json,
  recent commits). Useful but a separate Phase.
- **Iterative refinement** ("not quite — try again"). Today: edit the
  description and click Suggest again.
- **Caching** — every Suggest click hits OpenAI. Fine for low traffic;
  add caching when multiple agents hit it concurrently.
