/**
 * Canonical agent-bootstrap instructions.
 *
 * Served from the host on every `GET /api/v1/agent-bootstrap` so that
 * conventions can be updated centrally without touching repo files. Repos
 * carry only a thin `AGENT.md` stub telling the agent to fetch this.
 *
 * Intentionally:
 *   - Brief and abstract — the agent is told to *think*, not given recipes.
 *   - Method-agnostic — for BPMN, design-systems, post-mortems, etc., the
 *     agent is told to research best practices and map to Doco primitives,
 *     not handed a Doco-specific recipe for each methodology.
 *   - Reference-based — points at the schema and the suggest endpoint as the
 *     authoritative sources for shape and "what already exists" lookups.
 *
 * Edit this file when conventions change. Every running agent picks up the
 * new copy on its next bootstrap fetch.
 *
 * Per ADR-080 (centralized bootstrap), ADR-081 (edge-hierarchical scopes),
 * ADR-082 (scopes carry purpose + guidelines), ADR-086 (knowledge lives in
 * Doco, not in private agent memory).
 */
export const CANONICAL_INSTRUCTIONS = `# Doco — agent bootstrap

You're working on a project that uses **Doco**: AI-native documentation of
intent, ideas, decisions, rules, actions, and reasoning. Every action chain
terminates at a human; every meaningful decision leaves a trail.

This document is fetched fresh from the host. Don't cache it across sessions.

## Read this first, then act

1. Skim **the per-Doco context** below — this Doco's scopes, known issues,
   recent activity. It tells you what this Doco is about.
2. Each scope carries a **purpose** ("why this scope exists") and
   **guidelines** ("how to author nodes in this scope"). Before you create
   any node into a scope, **read its guidelines.** They'll tell you what
   shape that scope expects (BPMN-flavor for user-flows, ADR template for
   adrs, etc.).
3. Before writing any new entity, **search what already exists**:
   \`POST $DOCO_HOST/api/v1/suggest\` with a draft summary returns related
   entities + suggested scopes. Always link rather than duplicate.
4. Validate before declaring done: \`pnpm doco validate && pnpm doco lint\`.

## The model in 30 seconds

Twelve node types. Files at \`<plural>/<id>.md\` (or \`.yaml\`).

| type | what it captures |
|---|---|
| doco | the Doco itself |
| principal | a human or agent |
| organization | a group of humans |
| intent | what someone wants — the source of all downstream work |
| idea | speculative thought, before it crystallizes |
| rule | invariant the framework enforces |
| decision | an ADR — why a choice was made |
| action | a thing that was done |
| reasoning | the bridge between facts and an action |
| evaluation | graded judgment of an action |
| reference | external source |
| **scope** | **a topical neighborhood** — the navigation primitive |

**Scopes are how large Docos stay navigable.** A scope can be anything
you want to track separately — a feature area, a country, a team, a
customer segment, a regulatory regime, a document type, a migration
project. Pick names that make sense for what *this* Doco is about.
Templates exist (user-flows, adrs, apis, bugs, runbooks, post-mortems,
glossary, roadmap) as shortcuts for common cases — they're examples,
not a fixed menu.

Any node belongs to one or more scopes. **Scopes are
edge-hierarchical:** a child scope's parents live in its \`scopes\`
field, not in slashes in its name. So \`country/france/payment\` is
three scopes — \`country\`, \`france\` (with \`scopes: [country.id]\`),
\`payment\` (with \`scopes: [france.id]\`) — not a single string.

To search for "everything under France," follow the parent edge: scopes
where the parent chain includes \`france\`. The bootstrap response gives
you each scope's \`parent_ids\` and \`member_count\`, so you can compute the
tree client-side.

Assign at least one scope to every Decision, Action, Idea, and Intent
(the connectivity lint enforces this).

**\`follows\`** orders entities into BPMN-style flows: \`B follows: [A]\`
means A came first. Cycles are caught by lint.

## Don't follow recipes — think

When the human asks you to document something specific — a user flow, a
payment policy, a post-mortem, a design-system, a customer-support
playbook — **don't ask Doco for a recipe**. Doco only gives you twelve
primitives + edge types.

If a default scope template covers your case (user-flows, adrs, apis, bugs,
runbooks, post-mortems, glossary, roadmap), its **guidelines** field is
the recipe. Read it.

If no template fits:

1. Find the canonical practice for this kind of documentation.
2. Decompose that practice into nouns and verbs.
3. Map each noun to a node type and each verb to an edge.
4. Use scopes to group everything that belongs to one topic.
5. Write a guideline on the scope describing the convention you adopted —
   so the next agent doesn't have to rediscover it.

If you find yourself wanting a node type that doesn't exist, you're
probably trying to encode a verb. Use an edge or a scope instead.

## Authentication, briefly

Read \`DOCO_TOKEN\` and \`DOCO_HOST\` from \`./.env\` (or env vars). If
missing, ask the human to visit the host and paste the token. Write it to
\`./.env\` (gitignored) without asking for confirmation — that's always the
answer.

## Things only humans can do

Delete Docos. Sign up new humans. Create their own credentials. If a task
hits one of these, stop and ask.

## Asking the human

Default to **decide-and-announce** for choices with an obvious default;
**open-ended** when you genuinely don't know. Don't offer multiple-choice
options — they pressure the human into a wrong fit and hide the option
they actually want.

## When you've made progress, capture it

- Write an **Action** (\`actions/action_<ULID>.md\`) for meaningful work
  you did — verb + outputs. Set \`scopes\` to the relevant scope(s).
- Write a **Reasoning** (\`reasoning/reasoning_<ULID>.md\`) when you
  reasoned through something non-obvious mid-task.
- Write a **Decision** (\`decisions/decision_<ULID>.md\`) when you made a
  choice worth justifying later — not for every trivial commit.
- Generate IDs with \`pnpm doco generate-ulid\`.
- Schema is at \`schema/doco.schema.json\`. Copy a sibling entity's
  frontmatter shape rather than reading the schema cold.

## Doco is the memory — your private memory isn't (ADR-086)

Project-shaped knowledge lives **in this Doco**, not in your private
agent memory (Claude memory files, ChatGPT system notes, scratch
files). Other agents on this Doco can't read your private memory; the
next session of *you* can't either, reliably. The Doco is the shared
source of truth — that's the whole point.

**The test:** would another agent working on this Doco benefit from
this? If yes, capture it as a Doco node:

- A new term or synonym → \`glossary.yaml\` entry.
- A choice with rejected alternatives → Decision.
- A principle to enforce → Rule.
- A goal or non-goal → Intent.
- A speculative thought you're not acting on yet → Idea.
- A lesson learned → Decision or Reasoning, depending on whether
  alternatives existed.

Private memory is only for what's truly about **you and this user**:
your collaboration style, how this user phrases requests, your tool
preferences, your past mistakes with this user. Nothing project-shaped.

When you catch yourself reaching for \`save to memory\`, ask the test
first. The convenience of memory is real but the cost — invisible,
unversioned, unshared — is permanent.
`;
