/**
 * Default scope templates (ADR-082; v7 reshape per
 * decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * The framework ships five curated scopes. Two are auto-installed on
 * every new Doco (flagged `auto_install: true`): `#global` (the
 * Constitution) and `#important` (catch-all for important Doco-wide
 * decisions that don't fit a topical scope). The other three are opt-in:
 * `#user-flows` (opt-in at create time), `#state-machines` (opt-in
 * via `doco install-template #state-machines`), and `#business-processes`
 * (opt-in for repeatable operational workflows — BPMN/UML applied to
 * business operations). Per the successor to
 * decision_01KRFG5BAJ1ATHX0QE0HHX0QEV (which trimmed thirteen
 * templates down to two) — every other previously-shipped template
 * stays project-owner-authored. All scope names are hashtag-shaped —
 * the leading `#` is part of the canonical name on every surface.
 *
 * Each template ships:
 * - `purpose` — the description text rendered under the scope name on
 *   every surface (list card, detail page, bootstrap manifest). Written
 *   directly onto the Scope row's `purpose` column at install time.
 * - `rules` — atomic Rule entities tagged with the scope. A Rule with a
 *   `predicate` becomes an authoring rule the engine evaluates; the
 *   seeder writes the Rule's id into the scope's `gated_by` so the
 *   citation drives evaluation, not a flag on the Rule itself (per v7).
 * - `allowed_node_types` (optional) — a generic scope attribute that
 *   restricts which node types can be tagged into the scope. #global
 *   ships with `["rule"]` so the doco's constitution is a pure rule book;
 *   the framework rejects POSTs of any other node type whose `scopes`
 *   list names this scope.
 *
 * v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG) drops the
 * `kind: "authoring"` value from RuleKind. Templates no longer mark
 * rules "authoring" explicitly — any rule with a `predicate` is
 * automatically wired into the scope's `gated_by` at seed time. Use
 * `kind: "guidance"` for prose-only directives; leave `kind` unset (or
 * use "tagged") for rules with predicates.
 */
import type { AuthoringPredicate, Lifecycle } from "@doco/shared";

export interface TemplateRule {
  /**
   * Rule kind on the seeded Rule entity. Optional — defaults to
   * "tagged" when `predicate` is set, "guidance" otherwise. v7 dropped
   * "authoring" (decision_01KRRR5BQ16ASY8HQEE0V499YG).
   */
  kind?: "guidance" | "tagged";
  /** Human-authored prose. For rules with a predicate this is the reason
   * text accompanying the structured check. For guidance rules this IS
   * the rule. */
  summary: string;
  /**
   * Engine-readable predicate. When set, the seeder adds this Rule's id
   * to the scope's `gated_by` so the citation makes it an authoring
   * rule for that scope (v7).
   */
  predicate?: AuthoringPredicate;
  /**
   * v7: when set, the engine only fires this Rule against candidates
   * whose `lifecycle` is in the list. Used by completeness rules that
   * skip drafted nodes during mid-construction.
   */
  fires_when_node_lifecycle?: Lifecycle[];
  /**
   * Optional markdown body. Renders alongside the summary on the Rule's
   * detail page.
   */
  body_md?: string;
}

export interface ScopeTemplate {
  name: string;
  /** Short readable label for the picker UI. */
  label: string;
  /** Recommended single-emoji icon. */
  icon: string;
  /** Description text rendered under the scope name on every surface
   * (list card, detail page, bootstrap manifest). Written directly onto
   * the Scope row's `purpose` column at install time. */
  purpose: string;
  /** Atomic rules seeded at install time. */
  rules: TemplateRule[];
  /**
   * Generic scope attribute that restricts which node types are accepted
   * into the scope. When set, captures of any node whose `scopes` list
   * names this scope must have a `node_type` in this allowlist; others
   * are rejected. #global ships with `["rule"]` so the constitution is a
   * pure rule book. Drives behavior without any name-based check (per
   * rule_01KRRVPBS07HDBCXY6TJ5A5TAT).
   */
  allowed_node_types?: (
    | "decision"
    | "intent"
    | "action"
    | "rule"
    | "log"
    | "eval"
    | "reference"
    | "idea"
    | "state"
  )[];
  /**
   * v7: when set, captures into this scope (or descendants) default
   * the new node's `lifecycle` to this value unless the author
   * overrides with an explicit flag. The state-machines template uses
   * `"drafted"` so authors can sketch incomplete machines without
   * tripping completeness rules.
   */
  default_node_lifecycle?: Lifecycle;
  /**
   * When true, the framework installs this scope on every new Doco
   * automatically. When false/unset, the project owner opts in (via
   * the create-time picker, the scope manager, or
   * `doco install-template <name>`). Lets the auto-install set evolve
   * without name-driven branching in the creation handler — see the
   * Global rule "Keep framework behavior independent of scope names".
   */
  auto_install?: boolean;
  /**
   * Initial `watched` value applied when this template is auto-installed.
   * Only meaningful when `auto_install` is true. The project owner can
   * flip the value any time from the scope's edit page.
   */
  auto_install_watched?: boolean;
}

export const DEFAULT_SCOPE_TEMPLATES: ScopeTemplate[] = [
  {
    // Per decision_01KRPNZY7W6CCMYNKGND67BP0B the framework-seeded
    // scope renamed from "constitution" → "global". The label keeps
    // "Constitution" as the readable handle next to "#global" on the
    // scope list ("your doco's constitution"); the canonical name is
    // `#global` so it sorts predictably and reads as a hashtag tag
    // wherever it appears.
    name: "#global",
    label: "#global (your doco's constitution)",
    icon: "🌐",
    auto_install: true,
    auto_install_watched: true,
    purpose:
      "Your doco's rule book — the standing rules, invariants, and authority claims anyone can cite from anywhere. Rules only.",
    allowed_node_types: ["rule"],
    rules: [
      {
        kind: "guidance",
        summary:
          "Add each node to the most specific applicable scope. Don't create a new scope to fit a node. If you're an agent, propose it to your client and wait for their confirmation first.",
      },
      {
        kind: "guidance",
        summary:
          "If you're an agent, check with your client before adding a new rule to the global scope.",
      },
      {
        kind: "guidance",
        summary:
          "AI agents: document every explicit rule and decision from the project owner, and especially every correction. Corrections are the highest-signal moments — they encode preferences that aren't visible in the code or docs. Capture them in Doco the same turn they happen, so the next agent (or the next session of you) doesn't repeat the mistake.",
      },
    ],
  },
  {
    // Catch-all scope for important Doco-wide decisions that don't
    // naturally fit a topical scope. Auto-installed alongside #global
    // on every new Doco so the project owner has a landing place for
    // cross-cutting decisions from day one — the alternative is
    // letting orphan decisions push agents toward minting new scopes
    // (which Global Rule 1 explicitly forbids without confirmation).
    name: "#important",
    label: "#important",
    icon: "⭐",
    auto_install: true,
    auto_install_watched: true,
    purpose:
      "Important doco-wide decisions that don't naturally fit a more specific subject-area scope.",
    rules: [],
  },
  {
    // Per decision_01KRRD6QM7NN2EV56NZK96DNKY the #user-flows template
    // collapses from six guidance rules to deterministic authoring
    // rules + a concise summary for picker/manifest surfaces.
    name: "#user-flows",
    label: "#user-flows",
    icon: "🌊",
    purpose: "Document end-to-end user journeys as ordered steps, branches, and decisions.",
    rules: [
      {
        // Membership check: probabilistic semantic gate, with a
        // deterministic node-type allowlist that excludes Rule. Rules
        // tagged into #user-flows *govern* how journeys are authored;
        // they aren't themselves journey content, so subjecting them
        // to the journey-prose check would lock out the rules that
        // define the scope's contract.
        summary:
          "A node belongs in #user-flows only when it describes an end-to-end journey, a designed journey step, or a branch, route, form submission, handoff, or progression through a feature. (Rule nodes that govern user-flow authoring are exempt — they shape the scope rather than living inside it.)",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in #user-flows only when it describes an end-to-end journey, a designed journey step, or a branch, route, form submission, handoff, or progression through a feature.",
          when_node_type: ["intent", "action", "decision", "reference"],
        },
      },
      {
        summary:
          'Action nodes in #user-flows pass the summary style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.',
        predicate: {
          kind: "probabilistic",
          spec: 'Action nodes in #user-flows pass the summary style check when their readable text begins with the responsible principal, such as "User", "Human", "Doco host", or "GitHub", as part of a journey-step sentence. Literal label headings such as "Designed step:" or "Flow step:" fail.',
          when_node_type: ["action"],
        },
      },
      {
        summary:
          "Only Intent, Action, Decision, Reference, and Rule nodes belong to #user-flows. Evals, Ideas, and Logs each have their own home.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["intent", "action", "decision", "reference", "rule"],
        },
      },
      {
        summary:
          "Every Intent in #user-flows must declare the principal who wants the journey in the `wanted_by` field.",
        predicate: {
          kind: "requires_field",
          fields: ["wanted_by"],
          when_node_type: ["intent"],
        },
      },
      {
        summary:
          "Every Action in #user-flows must declare the principal who performs the designed step in the `actor_id` field.",
        predicate: {
          kind: "requires_field",
          fields: ["actor_id"],
          when_node_type: ["action"],
        },
      },
      {
        summary:
          "Every Decision in #user-flows must declare the principal who owns the branch or choice in the `decided_by` field.",
        predicate: {
          kind: "requires_field",
          fields: ["decided_by"],
          when_node_type: ["decision"],
        },
      },
      {
        summary:
          "Every Action in #user-flows must reference the journey Intent it advances (a `serves` edge to an Intent). Without it the flow renderer can't group steps into a coherent journey.",
        predicate: {
          kind: "requires_edge",
          edge_type: "serves",
          target_node_type: "intent",
          when_node_type: ["action"],
        },
      },
      {
        // #user-flows v2: each principal listed on the Intent's
        // `actors` must be the actor_id of ≥1 Action serving the
        // Intent. Fires only when the Intent moves to `active` —
        // drafted Intents can be captured first and have their Actions
        // filled in after.
        summary:
          "Every principal listed in an Intent's `actors` must be the `actor_id` of at least one Action that `serves` the Intent. Fires when the Intent is active — drafted Intents are allowed to be incomplete.",
        predicate: {
          kind: "graph-completeness",
          scope_ref: "$capture_scope",
          list_field: "actors",
          edge_type: "serves",
          incoming_node_type: "action",
          incoming_field_must_match: "actor_id",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ["active"],
      },
      {
        // user-flows v2: actor_id must point at a real Principal of
        // type human or agent — rejects "the browser", "app.js",
        // "the system" as actors. System-internal steps belong in
        // `apis` or `adrs`, not in a user-flow.
        summary:
          "An Action's `actor_id` must resolve to an existing Principal whose type is `human` or `agent`. System-internal steps (the browser, a background job, a script) belong in `apis` or `adrs`, not in a user-flow.",
        predicate: {
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          allowed_principal_types: ["human", "agent"],
          when_node_type: ["action"],
        },
      },
    ],
  },
  {
    // Per decision_01KRRR5BQ16ASY8HQEE0V499YG (v7): formal state-machine
    // modeling. The template is pure data — 18 atomic Rules attached
    // to the parent scope via gated_by (auto-wired by the seeder).
    // Framework primitives the rules use: State node + triggered_by /
    // gated_by edges + drafted lifecycle + scope-level
    // default_node_lifecycle + scope inheritance with excluded_rules.
    // Project owners rename the parent scope freely — the framework
    // treats every scope through the same generic interface (Global
    // rules rule_01KRRPY12JEVQABNNRJ96YB91J,
    // rule_01KRRPZTKDXT0RREZB37VPX2AG).
    name: "#state-machines",
    label: "#state-machines",
    icon: "🔁",
    purpose:
      "Track anything that moves through stages — orders, tasks, bug tickets, deploys. Each stage is a State; transitions are Actions.",
    default_node_lifecycle: "drafted",
    rules: [
      // ── Always-on deterministic (fire on any node lifecycle) ──
      {
        // D1 — the seeder tags the scope's seed Intent + Rules into this
        // scope too, so they have to be allowed. Idea and Log have their
        // own homes elsewhere.
        summary:
          "Only State, Action, Decision, Eval, Reference, Intent, and Rule nodes belong to a #state-machines scope. Other captures (Idea, Log) live elsewhere — Ideas are speculative until promoted; Logs capture recorded events rather than designed steps.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["state", "action", "decision", "eval", "reference", "intent", "rule"],
        },
      },
      {
        // D2
        summary:
          "`follows` edges in this scope alternate State ↔ Action — a transition Action follows a State, and a State follows the Action that produced it. Direct State → State or Action → Action `follows` edges break the wiring.",
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "alternates-between",
          node_types: ["state", "action"],
        },
      },
      {
        // D4
        summary:
          "State `summary` is unique within the capturing scope — duplicate State names ambiguate transitions and break referential semantics.",
        predicate: {
          kind: "unique-within-scope",
          scope_ref: "$capture_scope",
          node_type: "state",
          field: "summary",
        },
      },
      {
        // D7 — semantic: a terminal State has no successor Action. An
        // Action that fires AFTER a terminal State would carry
        // `follows: [<that-terminal-state>]`, materializing as an
        // incoming `follows` edge on the terminal State. Direction
        // `in` is the correct check (the prior `out` reading flipped
        // it and would have rejected properly-wired terminal States
        // that themselves follow their predecessor Action).
        summary:
          "Terminal States have no successor Action — no Action's `follows` may point at a terminal State.",
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "terminal" },
          direction: "in",
          max: 0,
        },
      },
      {
        // D9 + D10 collapse into one references-resolve-in-scope check
        // over the `follows` edge: every follows target must be a node
        // in the same scope. Catches typos that target nodes outside
        // the machine.
        summary:
          "A `follows` edge must point at a node in the same scope — a State / Action that has slipped out of scope (or a typo'd id) breaks the chain.",
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "references-resolve-in-scope",
          edge_type: "follows",
        },
      },
      // ── Active-only deterministic ──
      // These fire only on active captures and ignore drafted neighbors.
      // The lifecycle filter inside `where` is what lets the engine
      // count "active initial states" rather than "any initial state."
      {
        // D5
        summary:
          "An active #state-machines scope must have ≥1 active State of kind `initial` — every machine starts somewhere.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "count-within-scope",
          scope_ref: "$capture_scope",
          node_type: "state",
          where: { kind: "initial", lifecycle: ["active"] },
          comparator: ">=",
          n: 1,
        },
      },
      {
        // D6
        summary:
          "An active #state-machines scope must have ≥1 active State of kind `terminal`. Perpetual machines (worker loops, services) skip this Rule on their specific scope via `excluded_rules`.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "count-within-scope",
          scope_ref: "$capture_scope",
          node_type: "state",
          where: { kind: "terminal", lifecycle: ["active"] },
          comparator: ">=",
          n: 1,
        },
      },
      {
        // D8 — same direction semantics as D7. "Initial State has a
        // successor Action" = at least one Action's `follows`
        // includes this State, which is an INCOMING follows edge on
        // the State. The prior `out` reading would have rejected
        // properly-wired initial States.
        summary:
          "Each active initial State has ≥1 successor Action — otherwise the machine starts but never moves.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "initial", lifecycle: ["active"] },
          direction: "in",
          min: 1,
        },
      },
      {
        // D13
        summary:
          "Each active intermediate State is the `follows` target of ≥1 active Action — orphan intermediates (typos, dangling refactors) are caught at activate time.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "intermediate", lifecycle: ["active"] },
          direction: "in",
          min: 1,
        },
      },
      // ── Probabilistic ──
      // v7: each rule is gated to the node type it actually inspects so
      // the LLM judge isn't asked to evaluate, e.g., a State's summary
      // against a spec about compensating Actions.
      {
        // P1
        summary:
          "State `summary` reads as a noun or past-participle, not an imperative verb. Acceptable: `paid`, `cart`, `cancelled`. Not: `Pay`, `Cancel`, `Process the order`.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `summary` field. It must read as a noun or past-participle naming the position the modeled entity occupies (`cart`, `paid`, `cancelled`, `awaiting-review`). It must NOT be an imperative verb naming an action (`Pay`, `Cancel`, `Process the order`). A single-word past-participle adjective is acceptable.",
        },
      },
      {
        // P2
        summary:
          "An Action that transitions between States names the event or command, not the destination state. Acceptable: `checkout submitted`, `payment captured`. Not: `becomes paid`.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "An Action transitioning between States names the event or command, not the destination state.",
        },
      },
      {
        // P3
        summary:
          "State `invariants` are observable predicates a reader can check — `order.payment.captured = false`, not `the order is happy`.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `invariants` array. If `invariants` is empty, missing, or absent from the entity, this rule PASSES (vacuously true). When invariants are present, each entry must read as an observable predicate a reader can check programmatically (e.g., `order.payment.captured = false`), not a subjective quality (e.g., `the order is happy`). Do NOT judge the State's `summary` or `body_md` — only the invariants array matters here.",
        },
      },
      {
        // P4
        summary:
          "The #state-machines scope's purpose Intent names the entity being modeled (e.g., `order`, `worker job`, `agent session`) so readers can read the machine.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "probabilistic",
          when_node_type: ["intent"],
          spec: "The scope's purpose Intent names the entity being modeled.",
        },
      },
      {
        // P5 — fires only on Actions that look like compensating /
        // cancellation paths. Happy-path transitions pass.
        summary:
          "Compensating or cancellation transitions reference a Decision explaining why the path exists — they're the exceptional flow and need their reasoning recorded. Happy-path transitions are exempt.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "STEP 1 — decide whether this Action represents a compensating, cancellation, rollback, refund, undo, abort, abandon, or otherwise-undoing transition between States. Look at the Action's `verb` and `summary` for words like 'cancel', 'refund', 'rollback', 'undo', 'revert', 'abort', 'abandon', 'compensate', 'reverse'. If the Action is a normal happy-path transition (e.g., 'checkout submitted', 'payment captured', 'order shipped'), this rule PASSES — return ok. STEP 2 — only if the Action IS a compensating/cancellation transition, check that `decision_ids` is non-empty. If empty, FAIL with a reason explaining the Action looks like a compensating path but doesn't cite a Decision.",
        },
      },
      {
        // P-regions
        summary:
          "If a machine has multiple active States of kind `initial`, the scope's purpose Intent explains why — parallel regions, optional entry points, etc. — so readers don't assume it's a wiring mistake.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "probabilistic",
          when_node_type: ["intent"],
          spec: "When the scope has multiple active initial States, the scope's purpose Intent explains parallel regions or optional entry points.",
        },
      },
      {
        // P-orphan-transition
        summary:
          "A transition Action with empty `triggered_by` AND empty `gated_by` is either an explicit immediate transition (the body explains why it fires unconditionally) or an authoring oversight — capture the intent.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "A transition Action with empty triggered_by AND empty gated_by either explicitly justifies its unconditional firing in the body, or is an authoring oversight to flag.",
        },
      },
      // ── Descriptive (documentation-only) ──
      {
        // D11 (descriptive, not enforced)
        summary:
          "Reachability isn't enforced at the framework level. The completeness rules above catch missing wiring on activate (orphan intermediates) — strict reachability (every State reachable from an initial) is a manual review.",
        kind: "guidance",
      },
      {
        // D12 (descriptive)
        summary:
          "Hierarchical / composite / parallel States are deliberately not modeled in v1. A machine that needs them models the sub-machine as a separate scope under this scope's parent.",
        kind: "guidance",
      },
    ],
  },
  {
    // Business-process modeling template — BPMN/UML primitives applied to
    // repeatable operational workflows. Designed alongside #state-machines
    // (which models how an *entity* moves through stages) and #user-flows
    // (which models how a *user* moves through a feature). #business-processes
    // models how *work* moves through actors, gateways, and milestones to
    // produce a business outcome.
    //
    // Authored against the BPMN gateway/swimlane vocabulary: Principals are
    // swimlanes, Actions are activities, Decisions are gateways, States are
    // milestones / entry-exit conditions, Rules are policies/guards,
    // Evals are validation checks, References are external procedures or
    // recorded run pointers. Logs and Ideas are excluded — recorded
    // executions live in a separate Doco (referenced here) and speculative
    // thoughts don't belong in a designed repeatable process.
    //
    // Reuses State machinery from #state-machines (initial / intermediate /
    // terminal kind, invariants, follows-chain wiring). New ground vs the
    // sibling templates: actor-coverage via graph-completeness, explicit
    // input/output handoffs, exhaustive Decision branches, and compensation
    // for side-effecting Actions.
    name: "#business-processes",
    label: "#business-processes",
    icon: "🏭",
    purpose:
      "Document repeatable business processes — the flow of work through actors, gateways, and milestones to a business outcome. Inspired by BPMN swimlanes and gateways.",
    default_node_lifecycle: "drafted",
    rules: [
      // ── Membership ────────────────────────────────────────────────────
      {
        // BP-M1 — semantic membership. Reuses the user-flows pattern of a
        // probabilistic gate with a node-type allowlist that exempts the
        // Rule nodes governing the scope.
        summary:
          "A node belongs in #business-processes only when it describes part of a repeatable business process (its purpose Intent, an activity, a gateway, a milestone, an external reference, or a validation check) or a policy/guard for that process. One-off incidents, UI journeys, and pure state machines belong elsewhere.",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in #business-processes only when it describes part of a repeatable business process (its purpose Intent, an activity, a gateway, a milestone, an external reference, or a validation check) or a policy/guard for that process. One-off incidents (Logs), UI-specific journeys (#user-flows), and pure state machines without a business outcome (#state-machines) belong elsewhere.",
          when_node_type: ["intent", "action", "decision", "state", "eval", "reference"],
        },
      },
      {
        // BP-M2 — deterministic node-type allowlist. Logs and Ideas
        // excluded by design: this scope is for designed repeatable
        // processes, not recorded executions or loose thoughts.
        summary:
          "Only Intent, Action, Decision, State, Eval, Reference, and Rule nodes belong to #business-processes. Logs (recorded executions) live in a separate Doco and are referenced from here; Ideas live in their own home until promoted.",
        predicate: {
          kind: "requires_node_type",
          node_types: ["intent", "action", "decision", "state", "eval", "reference", "rule"],
        },
      },

      // ── Intent shape ─────────────────────────────────────────────────
      {
        // BP-I1
        summary:
          "Every Intent in #business-processes must declare the principals expected to act in the process in the `actors` field.",
        predicate: {
          kind: "requires_field",
          fields: ["actors"],
          when_node_type: ["intent"],
        },
      },
      {
        // BP-I2
        summary:
          "Every Intent in #business-processes must declare the principals whose interests the process serves in the `stakeholders` field. Stakeholders without an Action surface via Reference, Eval, or a gated_by Rule.",
        predicate: {
          kind: "requires_field",
          fields: ["stakeholders"],
          when_node_type: ["intent"],
        },
      },
      {
        // BP-I3 — process Intent prose
        summary:
          "The process Intent's summary or body states the business trigger that starts the process, the desired terminal outcome, and what is explicitly out of scope.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["intent"],
          spec: "The Intent's summary and body together state (1) the business trigger that starts the process, (2) the desired terminal outcome, and (3) what is explicitly out of scope. All three must be discernible — vague 'handle X' Intents fail.",
        },
      },

      // ── Action shape & handoffs ──────────────────────────────────────
      {
        // BP-A1
        summary:
          "Every Action in #business-processes must declare the principal who performs the activity in the `actor_id` field.",
        predicate: {
          kind: "requires_field",
          fields: ["actor_id"],
          when_node_type: ["action"],
        },
      },
      {
        // BP-A2 — actor_id resolves to a real Principal (human, agent, or
        // a role-principal representing a team). Permissive on type to
        // accommodate team-role Principals like 'kitchen', 'support', or
        // 'finance' — first-class per the BPM template's swimlane model.
        summary:
          "An Action's `actor_id` must resolve to an existing Principal. Team-role Principals (kitchen, support, finance, etc.) are first-class — a swimlane represents a role, not a person.",
        predicate: {
          kind: "requires_field_resolves_to_principal",
          field: "actor_id",
          allowed_principal_types: ["human", "agent"],
          when_node_type: ["action"],
        },
      },
      {
        // BP-A3
        summary:
          "Every Action in #business-processes must `serve` an Intent. Without it the process has no umbrella outcome to anchor the step.",
        predicate: {
          kind: "requires_edge",
          edge_type: "serves",
          target_node_type: "intent",
          when_node_type: ["action"],
        },
      },
      {
        // BP-A4
        summary:
          "Every Action in #business-processes must populate `inputs` — the business artifacts or data shapes it consumes. Empty `inputs` is a modeling gap; describe what flows in, even if 'context only'.",
        predicate: {
          kind: "requires_field",
          fields: ["inputs"],
          when_node_type: ["action"],
        },
      },
      {
        // BP-A5
        summary:
          "Every Action in #business-processes must populate `outputs` — the business artifacts or data shapes it produces. Outputs of one Action should line up with the inputs of the next; explicit handoffs are the spine of the model.",
        predicate: {
          kind: "requires_field",
          fields: ["outputs"],
          when_node_type: ["action"],
        },
      },
      {
        // BP-A6 — atomic activity prose
        summary:
          "Action summaries describe atomic business activities (a single decisive step a swimlane owner can complete). Vague phases ('handle request', 'process order') or implementation chores ('call API', 'update row') fail.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "The Action's verb + summary describes one atomic business activity that the responsible Principal completes in a single bounded act. Reject vague umbrella phases ('handle request', 'process order') and implementation chores divorced from business meaning ('call API', 'update database row').",
        },
      },
      {
        // BP-A7 — inputs/outputs are business artifacts
        summary:
          "Action `inputs` and `outputs` describe business artifacts or data shapes (e.g. 'signed-sow.pdf', 'verified-coverage-token'), not concrete runtime values or implementation primitives (HTTP status codes, SQL row counts).",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "STEP 1 — if both `inputs` and `outputs` are absent or empty, this rule PASSES (BP-A4/A5 handle missing fields). STEP 2 — otherwise judge whether the populated values name business artifacts or data shapes (signed-sow.pdf, verified-coverage-token, draft-invoice). FAIL when values are concrete runtime primitives (HTTP 200, row count = 4, the literal string 'success').",
        },
      },
      {
        // BP-A8 — compensation for side effects
        summary:
          "Actions with physical-world or financial side effects (shipments, payments, account state changes) declare a compensation Action via `decision_ids` or a `bounded_by` Rule citation, so the reversal path exists in the model.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "STEP 1 — decide whether this Action has a physical-world or financial side effect (ship goods, capture payment, activate subscription, send legally binding document, change account state). Read the verb and summary. If the Action is purely informational or internal (notify, log, validate, draft), this rule PASSES. STEP 2 — only if it has a side effect, check that the Action cites either a Decision (in decision_ids) that branches to a compensation path, or a Rule (in gated_by or referenced in body) describing the reversal. FAIL with a reason that names the missing compensation if neither is present.",
        },
      },
      {
        // BP-A9 — exception/cancellation cites rationale (mirrors
        // state-machines P5 but tightened for the BPM scope)
        summary:
          "Exception, cancellation, rollback, refund, rejection, or escalation Actions cite the Decision (in `decision_ids`) or Rule (in `gated_by`) that explains why the path exists. Happy-path activities are exempt.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "STEP 1 — decide whether this Action represents an exception, cancellation, rollback, refund, rejection, escalation, abort, deny, or otherwise non-happy-path transition. Look at the verb and summary for words like 'cancel', 'refund', 'reject', 'deny', 'escalate', 'rollback', 'compensate'. If happy-path, PASS. STEP 2 — only if non-happy-path, check that `decision_ids` is non-empty OR `gated_by` is non-empty. FAIL with a reason naming which is missing.",
        },
      },
      {
        // BP-A10 — sub-process invocation resolves
        summary:
          "An Action that delegates to a sub-process invokes that sub-process by Intent reference (via `intent_ids` or a body link) rather than inlining its steps. The referenced Intent should exist in this Doco or be reachable via a Reference.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "STEP 1 — decide whether this Action delegates to a sub-process (verbs like 'verify', 'authorize', 'approve' that name another business process, or summaries that say 'see X process'). If not a delegation, PASS. STEP 2 — if delegation, check that the Action either populates `intent_ids` with the sub-process's Intent OR cites a Reference in body/summary pointing at the sub-process. FAIL when steps are inlined despite naming an external process.",
        },
      },
      {
        // BP-A11 — loops bounded by Decision or Rule
        summary:
          "Loops in `follows` chains must declare a termination condition — either a Decision node on the cycle (BPMN-canonical) or a Rule citation in `gated_by` that bounds iteration (e.g. 'retries cap at 3'). Unbounded loops fail.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "STEP 1 — decide whether this Action's verb/summary suggests a retry, loop, or repeated step ('retry', 'reattempt', 'poll', 'loop until'). If no loop semantics, PASS. STEP 2 — if a loop, check that either decision_ids contains a Decision whose alternatives include an exit branch, or gated_by cites a Rule that explicitly bounds iteration (max count, timeout, predicate). FAIL when retry/loop language appears without either.",
        },
      },
      {
        // BP-A12 — timer / scheduled Action
        summary:
          "Timer-driven Actions (reminders, scheduled steps, T-24h notifications) name their anchor and offset in summary or body — e.g. 'fires PT24H after slot-confirmed entered_at'. Bare scheduling without an anchor fails.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "STEP 1 — decide whether this Action is timer-driven or scheduled (verbs/summaries with 'T-', '+N hours', 'after N days', 'reminder', 'scheduled', 'expires'). If not timer-driven, PASS. STEP 2 — if timer-driven, check that summary or body names both an anchor (a named State's entered_at, an absolute timestamp, or a previous Action's completion) and an offset in ISO 8601 form. FAIL when scheduling is implicit ('a few days later').",
        },
      },
      {
        // BP-A13 — trust-boundary handoff
        summary:
          "Actions that hand work across an organization, tenant, or external-system boundary flag the crossing in summary or body. Hidden cross-boundary transfers (data leaving the org, work crossing into a customer system) are a real risk surface and should be visible.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "STEP 1 — decide whether this Action's actor or counterparty is on the other side of an organization, tenant, or external-system boundary (e.g. sending data to Stripe, e-signature platform, an insurance clearinghouse, the customer's own system). If purely internal, PASS. STEP 2 — if a boundary crossing, check that the summary or body explicitly notes the crossing (phrases like 'crosses to', 'sends to external', 'leaves trust boundary', or names the external system). FAIL when the boundary is implicit.",
        },
      },

      // ── Decision shape ───────────────────────────────────────────────
      {
        // BP-D1
        summary: "Every Decision in #business-processes must `serve` an Intent.",
        predicate: {
          kind: "requires_edge",
          edge_type: "serves",
          target_node_type: "intent",
          when_node_type: ["decision"],
        },
      },
      {
        // BP-D2 — gateway shape
        summary:
          "Decisions read as BPMN gateways: a question whose alternatives separate exhaustive paths. Every Decision lists alternatives that cover every reachable case plus a default/else branch — silent 'otherwise' is the single biggest source of process drift.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["decision"],
          spec: "STEP 1 — check that the Decision's `question` reads as a yes/no or enumerated question. STEP 2 — check that `alternatives` is non-empty AND includes either a literal 'default' / 'else' / 'otherwise' branch or explicitly accounts for every case (e.g. an enum where every value is named). FAIL when alternatives leave room for an unhandled case.",
        },
      },
      {
        // BP-D3 — mutual exclusion
        summary:
          "Decision branches are mutually exclusive unless the gateway is explicitly inclusive. Overlapping branches without an 'inclusive' marker on the Decision body are a modeling smell.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["decision"],
          spec: "STEP 1 — check whether the Decision body or summary marks the gateway as 'inclusive' / 'OR' / 'parallel'. If marked inclusive, PASS. STEP 2 — for unmarked Decisions, check that the alternatives are mutually exclusive (no overlap in the conditions). FAIL when conditions overlap without the inclusive marker.",
        },
      },
      {
        // BP-D4 — too many branches
        summary:
          "Decisions with more than four branches are a smell — either nest them or model the discrimination as a classifier Action that feeds simpler downstream Decisions.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["decision"],
          spec: "Check the count of `alternatives`. PASS when ≤4. FAIL when >4, suggesting the Decision be split or preceded by a classifier Action.",
        },
      },

      // ── State shape & wiring ─────────────────────────────────────────
      {
        // BP-S1 — uniqueness within scope (same as state-machines D4)
        summary:
          "State `summary` is unique within the capturing scope. Duplicate names ambiguate transitions; either merge the nodes or disambiguate the summaries (`approved-by-manager` vs `auto-approved`).",
        predicate: {
          kind: "unique-within-scope",
          scope_ref: "$capture_scope",
          node_type: "state",
          field: "summary",
        },
      },
      {
        // BP-S2 — at least one initial (active only, same shape as
        // state-machines D5)
        summary:
          "An active #business-processes scope must contain at least one active State of kind `initial` — every process starts somewhere.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "count-within-scope",
          scope_ref: "$capture_scope",
          node_type: "state",
          where: { kind: "initial", lifecycle: ["active"] },
          comparator: ">=",
          n: 1,
        },
      },
      {
        // BP-S3 — at least one terminal (active only)
        summary:
          "An active #business-processes scope must contain at least one active State of kind `terminal`. Open-ended 'and then?' processes are rejected. Perpetual processes (continuous monitoring loops) skip this via `excluded_rules`.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "count-within-scope",
          scope_ref: "$capture_scope",
          node_type: "state",
          where: { kind: "terminal", lifecycle: ["active"] },
          comparator: ">=",
          n: 1,
        },
      },
      {
        // BP-S4 — terminal has no successor Action (same as
        // state-machines D7)
        summary:
          "Terminal States have no successor Action — no Action's `follows` may point at a terminal State.",
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "terminal" },
          direction: "in",
          max: 0,
        },
      },
      {
        // BP-S5 — initial has successor Action (active only)
        summary:
          "Each active initial State has ≥1 successor Action — otherwise the process declares its starting point but never moves.",
        fires_when_node_lifecycle: ["active"],
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "degree-bounds",
          where: { kind: "initial", lifecycle: ["active"] },
          direction: "in",
          min: 1,
        },
      },
      {
        // BP-S6 — follows resolves in scope
        summary:
          "A `follows` edge must point at a node in the same scope. Cross-scope wiring belongs to sub-process invocation (an Action with `intent_ids`), not raw `follows`.",
        predicate: {
          kind: "graph-constraint",
          scope_ref: "$capture_scope",
          graph: "follows",
          op: "references-resolve-in-scope",
          edge_type: "follows",
        },
      },
      {
        // BP-S7 — State summary as condition/milestone (reuses
        // state-machines P1 — same authoring discipline)
        summary:
          "State `summary` reads as a business condition or milestone, not imperative work: `application submitted`, `invoice approved`, `account active`. Not: `Submit application`, `Approve invoice`.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `summary` field. It must read as a business condition or milestone (a noun phrase or past-participle naming the position the work occupies: `application submitted`, `invoice approved`, `account active`). It must NOT read as imperative work (`Submit application`, `Approve invoice`). A milestone in transient form (`approved`) or a steady-state form (`active`) both qualify.",
        },
      },
      {
        // BP-S8 — milestone vs steady-state distinction
        summary:
          "State summaries distinguish transient milestones (true at one moment, succeeded by an Action) from steady-state conditions (true until something cancels them). Naming convention or invariants make the distinction visible.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check whether the State's summary, kind, and invariants together make clear whether this State is a transient milestone (entered then exited via a successor Action) or a steady-state condition (occupied for an extended span, exited only on cancellation). FAIL when a steady-state-shaped summary (`account active`, `subscription live`) has many outgoing successor Actions implying it's actually a milestone, or vice versa.",
        },
      },
      {
        // BP-S9 — observable invariants (mirrors state-machines P3)
        summary:
          "State `invariants` are observable predicates a reader can verify — `order.payment.captured = true`, not `the customer is happy`.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `invariants` array. If empty or absent, PASS (vacuously true). When present, each entry must read as an observable predicate a reader can check programmatically (`order.payment.captured = true`), not a subjective quality (`the customer is happy`).",
        },
      },
      {
        // BP-S10 — convergence at named State
        summary:
          "Parallel branches must converge at a named State with an explicit join predicate. Implicit re-convergence ('and then everything continues') is a modeling gap.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "STEP 1 — decide whether this State is a convergence point of multiple parallel branches (≥2 incoming Actions whose lineage diverged earlier). If a simple linear State, PASS. STEP 2 — if a convergence point, check that the summary or body names the join predicate (e.g. 'both parallel preparations complete', 'either-or sufficient'). FAIL when convergence is implicit.",
        },
      },

      // ── Coverage: actors must surface as actor_id ────────────────────
      {
        // BP-C1 — graph completeness (same shape as user-flows v2)
        summary:
          "Every principal listed in a process Intent's `actors` must be the `actor_id` of at least one Action that `serves` the Intent. Fires when the Intent is active — drafted Intents are allowed to be incomplete.",
        predicate: {
          kind: "graph-completeness",
          scope_ref: "$capture_scope",
          list_field: "actors",
          edge_type: "serves",
          incoming_node_type: "action",
          incoming_field_must_match: "actor_id",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: ["active"],
      },

      // ── Abstraction discipline ───────────────────────────────────────
      {
        // BP-X1 — consistent level of abstraction
        summary:
          "Actions within one process sit at a consistent level of abstraction. Mixing a fine-grained step (`Verify VAT checksum`) with a coarse one (`Onboard customer`) in the same process is a modeling smell — either split or roll up.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["action"],
          spec: "Check whether the Action's verb/summary scale is consistent with the other Actions in the same scope. A scope mixing 'Verify VAT checksum' (line-level technical detail) with 'Onboard customer' (multi-day business outcome) fails — both Actions cannot live at the right altitude simultaneously. If the Action being judged sits comfortably alongside its siblings, PASS.",
        },
      },

      // ── Eval shape ───────────────────────────────────────────────────
      {
        // BP-E1
        summary:
          "Every Eval in #business-processes must populate `target_ref` — the claim, Rule, or Action it tests.",
        predicate: {
          kind: "requires_field",
          fields: ["target_ref"],
          when_node_type: ["eval"],
        },
      },
      {
        // BP-E2 — Evals test process-critical claims
        summary:
          "Evals in #business-processes test process-critical claims: completeness (all listed actors play a part), required handoffs (output X reaches input Y), SLA behavior, branch coverage, or policy compliance. Decorative 'this should work' evals don't earn their keep.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["eval"],
          spec: "Check whether the Eval's description and criterion test something process-critical: an enumerated completeness property, a required handoff resolution, an SLA bound, a branch coverage check, or a policy compliance assertion. FAIL for vague evals ('the process works', 'no bugs') that don't pin a specific claim.",
        },
      },

      // ── Reference shape ──────────────────────────────────────────────
      {
        // BP-R1 — authoritative References
        summary:
          "References in #business-processes are authoritative sources for the modeled process (policy documents, regulatory citations, recorded-run Logs in a sibling Doco). Decorative links fail.",
        predicate: {
          kind: "probabilistic",
          when_node_type: ["reference"],
          spec: "Check whether the Reference is authoritative for the modeled process — a policy document, regulatory citation, vendor specification, or pointer to a sibling Doco that stores recorded process instances (Logs). FAIL for decorative links (a blog post, a tangentially related article) that don't ground a specific claim in the process.",
        },
      },

      // ── Guidance (prose, no predicate) ───────────────────────────────
      {
        kind: "guidance",
        summary:
          "Model a repeatable business process producing a business outcome — not a UI journey (#user-flows), a code path (#apis / #adrs), a one-off incident, or a pure state machine without a business outcome (#state-machines).",
      },
      {
        kind: "guidance",
        summary:
          "Use one child scope per concrete process when the process is large (e.g. `#customer-onboarding` under `#business-processes`). Small processes share the parent scope; split when crossing a durable ownership boundary, becoming reusable, or outgrowing one readable diagram.",
      },
      {
        kind: "guidance",
        summary:
          "Edge vocabulary: `follows` for process order (Action → State, State → Action), `triggered_by` for event causality between Actions, `gated_by` for policy/precondition guards (Action → Rule), `decision_ids` on Actions for gateway rationale.",
      },
      {
        kind: "guidance",
        summary:
          "Write the happy path first, then exceptions, compensation, rollback, cancellation, and escalation paths. Exception, cancellation, refund, rejection, or escalation Actions cite a Decision or Rule explaining why the path exists.",
      },
      {
        kind: "guidance",
        summary:
          "Sub-processes invoked from this process are themselves process scopes — reference them by their purpose Intent (via `intent_ids` or a body link), not by inlining their steps.",
      },
      {
        kind: "guidance",
        summary:
          "Process instances (recorded runs, executions) live in a separate Doco as Logs and are surfaced here only via References. This template describes the design, not the history.",
      },
      {
        kind: "guidance",
        summary:
          "Rules in this scope are process policies and guards (e.g. 'refunds above $5k require manager approval'). Template-authoring rules belong in the template definition (or in #global), not in any process that uses the template.",
      },
      {
        kind: "guidance",
        summary:
          "Make handoffs explicit: the producing Action's `outputs` should line up with the consuming Action's `inputs`. Implicit shared state ('the request', 'the customer record') hides where work is actually exchanged.",
      },
      {
        kind: "guidance",
        summary:
          "Do not model every click, method call, or database mutation unless it is meaningful to business operators. The acid test: would a non-engineering operator recognize this step as a thing they do?",
      },
    ],
  },
];

/**
 * Lookup a template by name. Returns undefined for unknown names.
 *
 * Templates are stored with their canonical hashtag-shaped names
 * (`#global`, `#user-flows`, `#state-machines`). For back-compat, the
 * lookup also accepts the bare form (`global`, `user-flows`,
 * `state-machines`) — older clients that POST `template_name: "global"`
 * continue to work.
 */
export function findScopeTemplate(name: string): ScopeTemplate | undefined {
  const canonical = name.startsWith("#") ? name : `#${name}`;
  return DEFAULT_SCOPE_TEMPLATES.find((t) => t.name === canonical);
}
