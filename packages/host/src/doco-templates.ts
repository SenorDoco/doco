/**
 * Default Doco templates (ADR-082; v7 reshape per
 * decision_01KRRR5BQ16ASY8HQEE0V499YG).
 *
 * The framework ships curated templates describing common Doco shapes
 * such as business processes and synced GitHub pull requests. Template
 * names are plain handles.
 *
 * Each template ships:
 * - `description` — the description text rendered in the picker and
 *   bootstrap manifest.
 * - `policies` — at install time each entry seeds one row in the unified
 *   `policies` table, classified by a standalone `kind` (translated in
 *   host.ts): a prose-only entry becomes a `suggestion` (advisory; the
 *   prose IS the agent instruction); an entry with a `probabilistic`
 *   predicate becomes a `probabilistic` policy (LLM-judged; the `spec` is
 *   the agent instruction); a `descriptive` predicate folds into a
 *   `suggestion` (recorded, not enforced); any other predicate becomes a
 *   `deterministic` policy (engine-checked, keyed by `sub_kind`).
 *
 * The historical guidance_policies / node_authoring_policies split — and
 * the older Rule.kind overloading (guidance / authoring / tagged) — are
 * both gone: every policy now lives in the one `policies` table, and
 * meta-constraints are policies, not Rule nodes
 * (decision_01KRRR5BQ16ASY8HQEE0V499YG).
 */
import type { AuthoringPredicate, Lifecycle } from "@doco/shared";

export interface TemplatePolicy {
  /** The one-line statement of the policy. REQUIRED for a prose-only
   *  suggestion entry — there it IS the policy and seeds the suggestion's
   *  agent instruction. REQUIRED (and the sole human description) for a
   *  `deterministic` entry, whose structured predicate carries no prose.
   *  OMITTED for `probabilistic` and `edge-probabilistic` entries, where the
   *  `predicate.spec` already IS the human-readable instruction the judge and
   *  agents see — a separate summary would just duplicate it. */
  policy?: string;
  /**
   * Engine-readable predicate. When set, the seeder records a
   * `deterministic` policy — or a `probabilistic` one, for a
   * `probabilistic` predicate — so the check can run at capture time.
   */
  predicate?: AuthoringPredicate;
  /**
   * When set, the engine only fires this policy against candidates whose
   * `lifecycle` is in the list. Completeness and quality gates use this to
   * hold a node to the bar once it is proposed (`queued`) and accepted
   * (`active`) while leaving a `drafting` sketch unjudged.
   */
  fires_when_node_lifecycle?: Lifecycle[];
  /**
   * Override the seeded policy's `on_violation` behavior. Defaults
   * to "block" when unset. Use "warn" for soft / probabilistic rules
   * the author wants surfaced but not enforced (e.g. semantic
   * membership gates), and "log" for purely descriptive recording.
   */
  on_violation?: "block" | "warn" | "log";
}

export interface TemplatePerspectiveAttachment {
  /**
   * Slug of a perspective in the `perspectives` table. The host
   * resolves the slug at template-application time, so a template
   * referencing a slug that no longer exists silently skips it
   * rather than failing the whole Doco creation. Built-in `graph`
   * and `list` may be referenced to make either built-in the default
   * without duplicating its tab.
   */
  slug: string;
  /**
   * When true, this perspective becomes the new Doco's default tab,
   * superseding the `graph` default. Only the first `isDefault: true`
   * in the list takes effect — additional defaults are ignored.
   */
  isDefault?: boolean;
}

export interface DocoTemplate {
  name: string;
  /** Short readable label for the picker UI. */
  label: string;
  /** Recommended single-emoji icon. */
  icon: string;
  /** Description text rendered in picker and bootstrap surfaces. */
  description: string;
  /** Atomic policies seeded at install time. */
  policies: TemplatePolicy[];
  /**
   * Optional perspectives to attach on Doco creation. The built-in
   * perspectives (graph, list) are always attached even
   * if this list is empty; entries here append after them. The
   * process template ships `[{slug:"process"}]` so a Doco
   * created from that template arrives with the BPMN tab ready.
   */
  perspectives?: TemplatePerspectiveAttachment[];
  /**
   * When set, captures into a Doco created from this template default
   * the new node's `lifecycle` to this value unless the author
   * overrides with an explicit flag. The process template
   * uses `"drafting"` so authors can sketch incomplete processes
   * without tripping completeness rules.
   */
  defaultNodeLifecycle?: Lifecycle;
}

/**
 * Process fires its completeness + shape policies on the two
 * *committed* lifecycle stages — `queued` (ready, awaiting activation) and
 * `active` (in force) — and exempts only `drafting`.
 *
 * Rationale (the `queued` stage): the node lifecycle is now
 * `drafting → queued → active → retired`. A node an author has explicitly
 * `queue`d is asserting it is ready to go live, so it must already satisfy
 * the same actor attribution (an `attributed_to` edge to a Principal), the
 * Intent it serves (a `supports` edge), and forward `flows_to` wiring an
 * `active` node does — otherwise "ready" is a lie the BPMN renderer can't
 * draw. Only a `drafting` sketch may be incomplete.
 *
 * This is scoped to process on purpose: it is the one template
 * that defaults new nodes to `drafting` and carries a real
 * draft → queue → activate authoring story. A template that defaults new
 * nodes straight to `active` would rarely pass through `queued`, and would
 * fire its gates on `["active"]` instead.
 *
 * This covers BOTH the completeness/shape gates and the flow-node
 * Principal-attachment gates (an Action is `performed_by`, a gateway Decision
 * `decided_by` a Principal). All of them fire on the committed stages only, so
 * a `drafting` sketch may be both incomplete AND unowned while the author
 * iterates — and is held to the full bar once it is committed. (`retired` is
 * excluded too: a winding-down node isn't re-judged, and the runner's
 * terminal-skip drops these `requires_edge` checks anyway.)
 */
const BUSINESS_PROCESS_COMMITTED_LIFECYCLES: Lifecycle[] = ["queued", "active"];

export const DEFAULT_DOCO_TEMPLATES: DocoTemplate[] = [
  {
    // Repeatable business processes modeled on BPMN swimlanes and
    // gateways. Sequence flow is explicit via first-class `flows_to`
    // edges; flow normally runs forward, but
    // rework loops may route back through a gateway. Generic Doco
    // dependency / rationale edges remain associations and are not
    // treated as BPMN arrows.
    //
    // Lifecycle: nodes default to `drafting` so a process can be sketched
    // freely; the completeness + shape rules — including serving an Intent and
    // naming the actor / decider Principal (an Action's and a gateway Decision's
    // `attributed_to` edge to a Principal) — fire on the committed stages
    // (`queued` and `active`) only (BUSINESS_PROCESS_COMMITTED_LIFECYCLES), so a
    // step can be drafted before its actor, decider, or Intent/pool is chosen,
    // and is held to the full bar only once it is committed.
    name: "process",
    label: "process",
    icon: "🔁",
    description:
      "Document repeatable business processes — the flow of work through actors, gateways, and milestones to a business outcome. Inspired by BPMN swimlanes and gateways.",
    defaultNodeLifecycle: "drafting",
    // Ship the BPMN perspective pre-attached and as the default tab,
    // so a freshly-created process Doco opens directly on
    // the swim-lane view (where the template's authoring rules are
    // most naturally visible). Graph + list defaults are still
    // attached behind it.
    perspectives: [{ slug: "process", isDefault: true }],
    policies: [
      // ── Membership ──────────────────────────────────────────────
      {
        // Soft semantic gate — fires as a `warn`, not a block. The author
        // opted into the template by installing it; the gate is meant to
        // surface "this looks like a one-off" so they can reconsider,
        // not to second-guess their template choice. Rule nodes are
        // exempt (they govern process authoring rather than being
        // process content) — handled by omitting "rule" from
        // when_node_type. Personal / informal workflows pass too:
        // the gate cares about "workflow with steps, actors, outcome",
        // not "this is paid work at a company".
        //
        // State is ALSO exempt. A milestone State viewed in isolation
        // ("loan approved", "incident mitigated") genuinely reads like a
        // bare state-machine stage, so the judge warned on the very
        // initial/terminal States the template REQUIRES — a false-positive
        // on every process. States are structural flow nodes admitted by
        // the node-type allowlist; their quality is governed by the
        // milestone-naming probabilistic policy below, not this membership
        // gate.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "A node belongs in process when it describes a workflow — a sequence of steps with actors and an outcome — or a policy/guard for one. Workflows can be commercial, operational, or personal; what matters is that the work is repeatable and the steps can be named. Pass when the candidate describes a step, gateway, milestone, validation, reference, or policy for such a workflow. Fail only when the candidate is a one-off incident with no repeatable structure, a UI-specific user journey, or a pure state machine without a workflow outcome.",
          when_node_type: ["intent", "action", "decision", "eval", "reference"],
        },
      },
      {
        // Deterministic node-type allowlist. Logs (recorded executions)
        // live in a sibling Doco and are surfaced here via Reference;
        // Ideas live in their own home until promoted. Policy records are
        // Doco-scoped metadata and bypass template membership gates in the
        // authoring evaluator.
        policy:
          "Only Intent, Action, Decision, State, Eval, Reference, Rule, and Principal belong here. Logs (recorded executions) live in a sibling Doco and are referenced from here; Ideas live in their own home until promoted.",
        predicate: {
          kind: "requires_node_type",
          node_types: [
            "intent",
            "action",
            "decision",
            "state",
            "eval",
            "reference",
            "rule",
            "principal",
          ],
        },
      },
      {
        // Edge-type allowlist (the edge analogue of the node-type allowlist
        // above). A business process wires sequence flow (`flows_to`), pool
        // membership and validation/rationale/evidence (`supports`), actor /
        // decider / owner attribution (`attributed_to`), policy guards
        // (`constrained_by`), supersession (`replaces`), and provenance
        // (`derived_from`). Org-chart hierarchy (`has_parent`) and bare
        // associative links (`relates_to`) have no BPMN meaning, so they are
        // barred — keeping a process graph drawable as swimlanes + sequence flow.
        policy:
          "Only these relationship edge types may be used in a process Doco: `flows_to`, `supports`, `attributed_to`, `constrained_by`, `replaces`, `derived_from`. Hierarchy (`has_parent`) and bare `relates_to` links belong in other Doco kinds.",
        predicate: {
          kind: "requires_edge_type",
          edge_types: [
            "flows_to",
            "supports",
            "attributed_to",
            "constrained_by",
            "replaces",
            "derived_from",
          ],
        },
      },
      {
        // Deterministic floor under the LLM prose judge below: a handful of
        // tokens are NEVER legitimate business prose — camelCase BPMN element
        // types and generated `Gateway_…`/`Task_…`/`SequenceFlow_…` ids, plus
        // the importer's "user asks:" scaffolding. Catch those cheaply and
        // deterministically; the ambiguous "is 'source'/'implementation'
        // business language?" calls stay with the judge.
        policy:
          "Process prose must not contain raw BPMN/import scaffolding tokens — camelCase BPMN element types or generated element ids leaked from an importer.",
        predicate: {
          kind: "forbids_field_pattern",
          fields: [
            "intent",
            "action",
            "decision",
            "question",
            "chosen",
            "state",
            "rule",
            "eval",
            "name",
          ],
          pattern:
            "(exclusiveGateway|parallelGateway|inclusiveGateway|eventBasedGateway|(?:Gateway|Task|UserTask|ServiceTask|SequenceFlow|StartEvent|EndEvent|BoundaryEvent|SubProcess|DataObject)_[A-Za-z0-9]+|user asks:)",
          flags: "i",
          when_node_type: ["intent", "action", "decision", "state", "eval", "rule", "principal"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Import provenance belongs in structured metadata, References,
        // or history, not in the labels/prose that BPMN readers scan.
        // This stays LLM-judged because terms like "source" and
        // "implementation" can be legitimate business language; the bad
        // case is raw importer/debug scaffolding leaking into process text.
        on_violation: "block",
        predicate: {
          kind: "probabilistic",
          spec: 'Check the candidate\'s visible user-facing text fields, including name, intent, action, decision, question, chosen, state, rule, and eval text. PASS when the text reads as business-process language for an operator or process reader, and any BPMN/source/import/code-evidence details are absent from visible prose or kept only in structured metadata, References, or audit/history. FAIL when visible text contains raw import scaffolding or implementation/source metadata, including phrases or patterns like "BPMN gateway", "BPMN task", "Gateway_...", "Implementation status", "Code evidence", "Source type", "exclusiveGateway", "user asks:", raw BPMN ids, generated object ids, or notes about code evidence discovered during import. Do not fail merely because a real business term happens to mention a job type, gateway, source, or implementation in ordinary process language; fail only when the prose exposes importer/debug/source metadata instead of the process meaning.',
          when_node_type: ["intent", "action", "decision", "state", "eval", "rule", "principal"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Principal shape ──────────────────────────────────────────
      {
        // Principals are the lane owners in the BPMN perspective.
        // Keep this as a warning: the principal endpoint permits a
        // quick name-only create, and the template should nudge
        // authors toward richer swim lanes without blocking a sketch.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Principal's `prose`. PASS when it clearly names a process actor — a role, team, external party, or system — and explains what responsibility or boundary it owns in this process. FAIL if it reads like an uncontextualized org-chart person, a vague label (`user`, `team`, `system`) with no process responsibility, or an empty shell with only a bare name.",
          when_node_type: ["principal"],
        },
      },

      // ── Intent shape ────────────────────────────────────────────
      {
        // Whole-field judge: the purpose Intent identifies a single
        // repeatable business process and reads as a concise statement of its
        // purpose. Graded over the ENTIRE `intent` field — never a single
        // line. A line-shaped check (the former `field-line-shape` floor +
        // "first line" judge) distorted the field's vector embedding and
        // forced a headline structure into the prose; if a short process name
        // is wanted it is the author's to phrase within the field, not a
        // separately-graded first line. The Intent also no longer restates the
        // trigger, terminal outcome, or out-of-scope boundary — those live
        // structurally as the process's initial State, terminal State, and
        // flow wiring.
        predicate: {
          kind: "probabilistic",
          spec: "Read the ENTIRE `prose` field. PASS when it identifies a single repeatable business process — recognizable as a verb + object (e.g. `publish a job`), optionally with an adjective or adverb — and reads as a concise statement of that process's purpose. FAIL when no single process is identifiable, when several distinct processes are bundled together, or when it sprawls into a multi-paragraph specification instead of a focused purpose. Grade the whole field; do not privilege or judge any single line.",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Action shape ────────────────────────────────────────────
      {
        // Completeness — fires on the committed stages only (see
        // BUSINESS_PROCESS_COMMITTED_LIFECYCLES): a `drafting` Action may be
        // sketched without an actor, but a committed step must be attributed to
        // the Principal who performs it. With edge roles gone, an Action's
        // `attributed_to` edge to a Principal IS the performer link — the source
        // node type (action) carries that meaning. Authors create the Action and
        // its `attributed_to` edge together in one changeset.
        policy:
          "Every committed (`queued` or `active`) Action in process is attributed to the Principal who performs it — an `attributed_to` edge from the Action to that Principal. A `drafting` sketch may defer this — naming the actor is not required while drafting.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["action"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // One rule for all three flow-node types, filtered by `when_node_type`.
        // With roles gone, a flow node's `supports` edge to an Intent IS its
        // pool membership ("serves") — the endpoint types (flow node → intent)
        // carry the meaning. Without it the BPMN renderer can't place the node
        // in a pool, and the step floats free of the business outcome it advances.
        policy:
          "Every committed (`queued` or `active`) flow node in process — Action, gateway Decision, or milestone/event State — links to the Intent it serves with a `supports` edge to that Intent. Without it the BPMN renderer can't place the node in a pool, and the step floats free of the business outcome it advances. A `drafting` sketch may defer this link.",
        predicate: {
          kind: "requires_edge",
          edge_type: "supports",
          target_node_type: "intent",
          when_node_type: ["action", "decision", "state"],
        },
        // Completeness — a flow node need NOT serve an Intent while it is a
        // `drafting` sketch (so a step can be drafted before its Intent/pool is
        // chosen); the link is required once the node is committed (`queued` or
        // `active`), like the actor/decider completeness gates.
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // The CEILING that complements the serves FLOOR above. With roles gone, a
        // flow node's `supports` edge to an Intent IS its pool membership; this
        // caps it at one, so combined with the ≥1 gate a committed flow node
        // belongs to EXACTLY one BPMN pool. A node linked to two Intents is
        // ambiguous: the renderer can't decide which pool owns it, and the step's
        // business purpose is no longer singular. Like the floor it mirrors, it
        // fires on the committed stages only (BUSINESS_PROCESS_COMMITTED_LIFECYCLES)
        // — a `drafting` sketch is exempt. A sub-process calling Action links only
        // to its child purpose Intent (its pool) and is woven into the parent flow
        // by `flows_to`, so it too stays single-Intent. Re-point by retiring the
        // old `supports` edge before adding the new one; endpoints are immutable.
        policy:
          "Every committed (`queued` or `active`) flow node in process — Action, gateway Decision, or milestone/event State — links to AT MOST one Intent via `supports`: it belongs to exactly one process pool. Combined with the gate that requires at least one Intent on a committed node, a flow node serves exactly one. A node linked to two Intents is ambiguous — the BPMN renderer can't place it in a single pool. A `drafting` sketch is exempt. Re-point by retiring the old `supports` edge before adding the new one.",
        predicate: {
          kind: "limits_edge",
          edge_type: "supports",
          target_node_type: "intent",
          max_count: 1,
          when_node_type: ["action", "decision", "state"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Sub-process naming, enforced on the EDGE (not on either node). A
        // sub-process is designed by connecting a calling Action to a child
        // purpose Intent with a `supports` edge; the Intent's name should be the
        // base (imperative) form of that Action (`Posts a job` → `Post a job`).
        // The convention spans two nodes, so it can't live on either alone — the
        // node judge sees only its own candidate. This edge-scoped check fires
        // when the Action→Intent `supports` edge is created and hands the judge
        // BOTH endpoints. A STEP-1 gate makes ordinary flow-step links (an Action
        // that is merely one step, not a sub-process expansion) PASS, so only
        // true sub-process pairings are graded.
        predicate: {
          kind: "edge-probabilistic",
          edge_type: "supports",
          from_node_type: "action",
          to_node_type: "intent",
          spec: "You are checking a `supports` relationship from an Action (the `action` endpoint) to a purpose Intent (the `intent` endpoint). STEP 1 — decide whether this is a SUB-PROCESS pairing: the Intent names the SAME single activity as the Action, expanded into its own process (e.g. Action `Posts a job` ↔ Intent `Post a job`). If instead the Action is merely one step within a broader process the Intent names (e.g. Action `review the application` supporting Intent `Approve a consumer loan`), this is an ordinary flow-step link, not a sub-process — PASS, the rule does not apply. STEP 2 — for a sub-process pairing, PASS when the Intent's name is the base (imperative) verb form of the Action, i.e. the Action's third-person verb converted to its base form (`Posts a job` → `Post a job`, `Approves the invoice` → `Approve the invoice`). FAIL with `intent name is not the base form of the action` when the Intent's name is in the third-person singular present tense (a verb ending in `-s`) or otherwise does not read as the base-form imperative of the same activity.",
        },
      },
      {
        // Atomic activity prose — surface umbrella phases and
        // implementation chores divorced from business meaning. Fires as a
        // `warn`, not a block: it's an LLM-judged style check, so a blocking
        // verdict both stopped legitimate single-verb steps ("Reviews the
        // legal terms") and was non-deterministic (an identical retry could
        // pass). Warn keeps the nudge without trapping the author. The spec
        // now PASSES an ordinary single-verb business step and reserves the
        // FAIL for true umbrellas and conjunction ("examine AND treat")
        // steps that bundle two activities.
        on_violation: "warn",
        predicate: {
          kind: "probabilistic",
          spec: "Check the Action's `prose` and `verb`. PASS when the text names a single business activity the named actor performs — an ordinary single-verb step like `review the legal terms`, `approve the invoice`, or `pack the order` PASSES. FAIL with reason only if the text (a) is a vague umbrella phase covering many steps (e.g. `handle request`, `do the thing`, `process order`), (b) bundles two distinct activities joined by `and` (e.g. `examine and treat the patient`), or (c) is an implementation chore divorced from business meaning (e.g. `call API`, `update row`, `write to DB`).",
          when_node_type: ["action"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      // ── Decision shape ──────────────────────────────────────────
      {
        // Structural floor for a gateway: it branches, so it carries ≥2
        // outgoing `flows_to` edges. A single-exit Decision is a plain step,
        // not a gateway. Deterministic; the exhaustiveness/enum-coverage of
        // those branches is the LLM judge's job, below.
        policy:
          "A gateway Decision branches: it has at least two outgoing `flows_to` edges. A Decision with a single exit is a step, not a gateway.",
        predicate: {
          kind: "requires_edge",
          edge_type: "flows_to",
          min_count: 2,
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // Exhaustive branches: question reads as yes/no or enumerated,
        // and the alternatives list either has a default/else branch
        // or covers every enum value.
        predicate: {
          kind: "probabilistic",
          spec: "Check the Decision's `question`, `alternatives`, and any outgoing `flows_to` branch labels/conditions. PASS when the question reads as yes/no or an enumeration, AND the alternatives / outgoing branches either include an explicit default/else branch or name every enumerated value. FAIL with reason if the question has uncovered cases or if a default/else is missing where enum coverage isn't visibly complete.",
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // A gateway routes the flow; strict BPMN leaves the diamond itself
        // unowned and lets the surrounding activities carry accountability.
        // We make that accountability explicit instead: every gateway is
        // attributed to the Principal answerable for the call, via an
        // `attributed_to` edge. With roles gone, a Decision's `attributed_to`
        // edge to a Principal IS its decider (source node type = decision).
        // Mirrors the Action gate, and like it fires on the committed stages only
        // (see BUSINESS_PROCESS_COMMITTED_LIFECYCLES): a `drafting` gateway may be
        // sketched without a decider, but a committed one must name it or it
        // floats into the BPMN "Unassigned" lane.
        policy:
          "Every committed (`queued` or `active`) gateway Decision in process is attributed to the Principal answerable for the call — an `attributed_to` edge from the Decision to that Principal. A `drafting` sketch may defer this. A gateway with no such Principal floats into the Unassigned lane.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["decision"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── State shape & sequence wiring ───────────────────────────
      {
        // Doco-level existence ("≥1 initial, ≥1 terminal") stays prose: the
        // per-candidate evaluator can't assert "the graph contains a terminal
        // State". The per-node shape rules below ARE engine-checked.
        policy:
          "A business process has ≥1 committed (`queued` or `active`) initial State and ≥1 committed terminal State. Every process starts somewhere and ends at a business outcome (or an explicitly cancelled outcome).",
      },
      {
        // Milestone names must be unambiguous within the Doco. Deterministic:
        // `unique_field` compares the candidate's `state` against other active
        // States.
        policy:
          "Each `state` milestone name is unique among the process's committed States, so a reader can name a milestone unambiguously.",
        predicate: {
          kind: "unique_field",
          field: "state",
          case_fold: true,
          when_node_type: ["state"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // The sequence-flow completeness invariant — formerly prose-only, now
        // engine-checked. A committed flow node must be wired into the process:
        // reachable (≥1 incoming `flows_to`) unless it is an initial State, and
        // leading somewhere (≥1 outgoing `flows_to`) unless it is a terminal
        // State — which conversely must carry NO outgoing `flows_to`. This is
        // what stops an agent from queuing/activating a dangling mid-flow node.
        policy:
          "Flow runs forward from the initial State: each committed (`queued` or `active`) initial State has ≥1 outgoing `flows_to` edge, every non-initial flow node is reachable through an incoming `flows_to`, and every non-terminal flow node has ≥1 outgoing `flows_to`. Terminal States have no outgoing `flows_to` — they end the process path.",
        predicate: {
          kind: "flow-wiring",
          edge_type: "flows_to",
          initial_when: { field: "kind", equals: "initial" },
          terminal_when: { field: "kind", equals: "terminal" },
          when_node_type: ["action", "decision", "state"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // State summary as milestone/condition — noun or past-participle
        // naming the milestone.
        predicate: {
          kind: "probabilistic",
          when_node_type: ["state"],
          spec: "Check ONLY the State's `state`. PASS when the text reads as a milestone or entry/exit condition — a noun or past-participle (`invoice approved`, `payment captured`, `cart`, `awaiting-review`). FAIL with reason if it reads as an imperative verb naming an Action (`Approve invoice`, `Process the order`).",
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Coverage ────────────────────────────────────────────────
      {
        // Every actor Principal earns its swim lane by being the target of ≥1
        // Action's `attributed_to` edge (an incoming performer link). A `warn`,
        // and structurally exempt for the accountable owner — the Principal an
        // Intent is `attributed_to` — who performs no step yet is legitimately
        // present. With roles gone, performer vs owner is told apart by the
        // OTHER endpoint's type: an incoming `attributed_to` from an Action is a
        // performer link; one from an Intent marks the owner.
        on_violation: "warn",
        policy:
          "Each actor Principal in the process is the target of at least one Action's `attributed_to` edge. The single accountable process owner — the Principal an Intent is attributed to — is exempt.",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          direction: "incoming",
          target_node_type: "action",
          exempt_when_other_node_type: "intent",
          when_node_type: ["principal"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },
      {
        // The accountable process owner — a `warn` gate. A committed process
        // Intent should be attributed to its owner via an `attributed_to` edge
        // to a Principal. Kept as `warn` (not block) because a sub-process child
        // Intent may inherit ownership rather than re-declare it, and we don't
        // want to false-positive on those.
        on_violation: "warn",
        policy:
          "Name the single accountable process owner in the purpose Intent and link it with an `attributed_to` edge to the Principal answerable for the whole process's outcome (the RACI 'Accountable' role, distinct from the per-step performers).",
        predicate: {
          kind: "requires_edge",
          edge_type: "attributed_to",
          target_node_type: "principal",
          when_node_type: ["intent"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Eval ────────────────────────────────────────────────────
      {
        policy:
          "Every Eval in process links to the node whose claim it pins with a `supports` edge to that node.",
        predicate: {
          kind: "requires_edge",
          edge_type: "supports",
          when_node_type: ["eval"],
        },
        fires_when_node_lifecycle: BUSINESS_PROCESS_COMMITTED_LIFECYCLES,
      },

      // ── Guidance (prose-only) ───────────────────────────────────
      {
        policy:
          "Model a repeatable business process that produces a business outcome — not a UI journey, a code path, an incident, or a pure state machine. UI journeys and pure state machines belong in their own Docos.",
      },
      {
        policy:
          "Use one linked Intent per concrete process when the Doco is large. Split on a durable ownership boundary, reuse across multiple parents, or pure readability.",
      },
      {
        policy:
          "When a step is itself a whole sub-process, model it as its own child process Intent and connect the calling Action to it with a `supports` edge instead of inlining dozens of Actions. The BPMN view collapses the child Intent into its own pool, keeping the parent process readable.",
      },
      {
        // The naming convention that keeps an Action→Intent `supports` pairing
        // legible: the same activity is named once as work performed (the
        // Action, third-person — `Posts a job`) and once as the goal it serves
        // (the child purpose Intent, imperative base form — `Post a job`). This
        // is authoring guidance, not an enforced gate: the convention spans two
        // nodes (compare the child Intent's name against the calling Action's),
        // and the write-time judge only sees the single candidate's fields, so
        // it can't compare across the `supports` edge.
        policy:
          "Name a sub-process by pairing a calling Action with a child purpose Intent through a `supports` edge, and derive the Intent's name from that Action: take the base form (the imperative) of the Action's verb, which is normally written third-person. For example, the Action `Posts a job` becomes the child Intent `Post a job`. The two read as the same activity — one as the work performed, one as the goal it serves.",
      },
      {
        policy:
          "Name the single accountable process owner in the purpose Intent and link it with an `attributed_to` edge from the Intent to that Principal — the one answerable for the whole process's outcome. This is the RACI 'Accountable' party, distinct from the per-step 'Responsible' performers, each named by an `attributed_to` edge from their Action.",
      },
      {
        policy:
          "Agents should read `GET /<handle>/api/authoring-contract.json` and write structured flows with `POST /<handle>/api/changesets.json`; create flow nodes and their relationship edges in the same changeset, using the contract's edge types instead of disconnected nodes or ad hoc relationship names.",
      },
      {
        policy:
          "Use `relate_many` for sibling edges that must be valid together, especially exhaustive gateway branches. Adding one branch at a time can create a temporarily invalid BPMN graph.",
      },
      {
        policy:
          "BPMN vocabulary — an edge's meaning comes from its type plus the node types it connects, not from any role tag: `flows_to` is process order and renders source -> target with no reversal; a `supports` edge from a flow node to an Intent places it in that Intent's pool; an `attributed_to` edge to a Principal drives actor lanes (from an Action), gateway deciders (from a Decision), and process ownership (from the purpose Intent); a `constrained_by` edge to a Rule links a policy guard; a `supports` edge from an Eval tests the node it points at, and `supports` edges from other nodes carry rationale and evidence.",
      },
      {
        policy:
          "`flows_to` edges may carry props like `{ label, condition, kind }`. Put gateway branch labels and default/exception/timer metadata on the outgoing edge, not by reversing a relationship from the downstream Action back to the Decision.",
      },
      {
        policy:
          "For parallel work, give one flow node multiple unconditional `flows_to` outgoing edges — an AND-split needs no gateway Decision. Reserve gateway Decisions for exclusive or conditional (XOR/inclusive) branching, and reconverge parallel branches on a shared downstream node.",
      },
      {
        policy:
          "Rework and retry loops are allowed: a `flows_to` edge may target an earlier flow node to send work back (revise-and-resubmit, fix-and-recheck). Route the loop back through a gateway Decision so the cycle has an explicit exit and can't spin forever. A single edge still renders source -> target — a loop is about where the edge points, not reversing its direction.",
      },
      {
        policy:
          'Model the unhappy path. Use `flows_to` edge props with `kind: "exception"` or `kind: "timer"` to route failures, rejections, and timeouts to a recovery step or an explicitly cancelled terminal State, so the process documents what happens when the happy path does not hold.',
      },
      {
        policy:
          "Relationships in a process Doco are first-class edges with lifecycle and history. Use `flows_to` for process order and the canonical families (`supports`, `attributed_to`, `constrained_by`, `has_parent`, `derived_from`, `replaces`, `relates_to`); an edge's specialized meaning comes from its type plus the node types it connects, not from a role tag. Re-point by retiring the old edge and adding the new one; endpoints are immutable.",
      },
      {
        policy:
          "Walk a process node through the four-stage lifecycle drafting → queued → active → retired. A `drafting` sketch may be incomplete — serving an Intent, naming the actor or decider Principal (an Action's or gateway Decision's `attributed_to` edge to a Principal), forward `flows_to` wiring, gateway exhaustiveness, milestone naming, and quality are all suspended, so a step can be drafted before its actor, decider, or Intent (and BPMN pool) is chosen. `queue` it (changeset op `queue`) once it supports its Intent and its forward `flows_to` wiring is coherent and the design is ready; `activate` it (op `activate`) when it is the governing, in-force process. Both committed stages — `queued` and `active` — are held to the full shape rules. `retire` a node when it is withdrawn, or `supersede` it when a redesign replaces it (the op creates the replacement and links the two with a `replaces` edge).",
      },
      {
        policy:
          "Use `queued` for a process — or a single step, gateway, or milestone — that is fully wired and ready but not yet in force: a redesign awaiting sign-off, a step pending a scheduled go-live, or an approved-but-not-yet-rolled-out change. A `queued` node asserts readiness, so it must already satisfy the same actor attribution, supporting Intent, and forward-flow wiring an `active` node does. If it is still being sketched and that wiring is incomplete, leave it `drafting` instead of queuing it.",
      },
      {
        policy:
          "Process *instances* (recorded runs) live in a separate Doco as Logs; surface them here only via References. This template describes the design of the process, not the history of its executions.",
      },
      {
        policy:
          "Rules in a process Doco are process policies and guards (`refunds above $5k require manager approval`). Template-authoring rules — meta-rules about how to write process Docos — belong in the template or in `global`, not in any process using it.",
      },
      {
        policy:
          "Don't model every click, method call, or DB mutation — only the steps that mean something to a business operator. Implementation detail belongs in `apis` or code Docos, not here.",
      },
    ],
  },
  {
    // GitHub pull-requests template. PRs from a connected repository are
    // synced as Reference nodes. No authoring constraints are imposed —
    // the template is intentionally minimal; the GitHub integration
    // (configured immediately after Doco creation) handles the sync logic.
    name: "github-pull-requests",
    label: "GitHub pull requests",
    icon: "🐙",
    description:
      "Track a GitHub repository's pull requests as References — new PRs sync automatically, and merged PRs settle as active.",
    policies: [],
    // Default the overview to the Pull requests perspective (seeded by
    // migration 076). Resolved by slug at apply time; silently skipped if the
    // builtin row isn't present.
    perspectives: [{ slug: "pull-requests", isDefault: true }],
  },
];

/**
 * Lookup a template by name. Returns undefined for unknown names.
 *
 * Templates are stored under plain handles (`process`,
 * `github-pull-requests`).
 */
export function findDocoTemplateByName(name: string): DocoTemplate | undefined {
  return DEFAULT_DOCO_TEMPLATES.find((t) => t.name === name);
}

/**
 * The essence of a seeded policy row — a standalone `kind` plus the
 * predicate the evaluator dispatches on. This is the pure translation
 * from the (still old-shape) `TemplatePolicy` into the unified policies
 * table introduced in #909; `host.ts` wraps it with the DB-row metadata
 * (ids, timestamps, `template_seeded`) at Doco-creation time.
 */
export interface SeededPolicyRow {
  kind: "suggestion" | "deterministic" | "probabilistic";
  /**
   * suggestion / probabilistic → `{ agent_instruction, when_node_type? }`
   * deterministic              → `{ sub_kind, ...check params }`
   */
  predicate: Record<string, unknown>;
  /** Set for deterministic / probabilistic policies (defaults to "block"); omitted for suggestions. */
  on_violation?: "block" | "warn" | "log";
  fires_when_node_lifecycle?: Lifecycle[];
}

/**
 * Translate one `TemplatePolicy` into the unified policy row the evaluator
 * consumes. Split purely by predicate shape:
 *   - no predicate                    → `suggestion` (the prose is the instruction)
 *   - `probabilistic`                 → `probabilistic` (LLM-judged at write time)
 *   - `descriptive`                   → `suggestion` (recorded, not enforced)
 *   - any other (structured) predicate → `deterministic`, keyed by `sub_kind`
 *
 * Shared by `host.ts` (which seeds these rows) and the template scenario
 * tests (which run them through the real evaluator), so the two can never
 * drift apart.
 */
export function templatePolicyToPolicyRow(policy: TemplatePolicy): SeededPolicyRow {
  const pred = policy.predicate;
  let kind: SeededPolicyRow["kind"];
  let predicate: Record<string, unknown>;
  if (!pred) {
    kind = "suggestion";
    predicate = { agent_instruction: policy.policy ?? "" };
  } else if (pred.kind === "probabilistic" || pred.kind === "descriptive") {
    // `descriptive` was recorded-but-not-enforced → folds into suggestion.
    kind = pred.kind === "probabilistic" ? "probabilistic" : "suggestion";
    predicate = {
      agent_instruction: pred.spec,
      ...(pred.when_node_type ? { when_node_type: pred.when_node_type } : {}),
    };
  } else if (pred.kind === "edge-probabilistic") {
    // Edge-scoped probabilistic: LLM-judged like `probabilistic`, but fires on
    // edge creation with both endpoints handed to the judge. The edge scoping
    // (edge_type / endpoint node types) rides on the seeded predicate.
    kind = "probabilistic";
    predicate = {
      agent_instruction: pred.spec,
      edge_type: pred.edge_type,
      ...(pred.from_node_type ? { from_node_type: pred.from_node_type } : {}),
      ...(pred.to_node_type ? { to_node_type: pred.to_node_type } : {}),
    };
  } else {
    kind = "deterministic";
    const { kind: subKind, ...rest } = pred;
    predicate = { sub_kind: subKind, ...rest };
  }
  const firesWhen = Array.isArray(policy.fires_when_node_lifecycle)
    ? policy.fires_when_node_lifecycle
    : [];
  return {
    kind,
    predicate,
    ...(kind !== "suggestion" ? { on_violation: policy.on_violation ?? "block" } : {}),
    ...(firesWhen.length > 0 ? { fires_when_node_lifecycle: firesWhen } : {}),
  };
}
