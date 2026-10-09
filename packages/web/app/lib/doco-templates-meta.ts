// Shared template metadata used by the /new-doco wizard, the agent recipes,
// the Doco type icons (components/doco-type-icon.tsx) and the Doco lists. The handles must
// match the ones the host package's `findDocoTemplateByName` knows about —
// they're passed verbatim to `createDocoInWorkspace`. The list is in the
// order the /new-doco picker shows it: Generic first, then A to Z by label.

import type { NodeType } from "@doco/shared";

/** The one thing a kind of Doco holds, as its lists name and count it. What
 *  counts as one: a node of one type, any node, an item imported from the
 *  Doco's source (a file, a message, a page), or a process (an Action with
 *  child Actions). */
export interface DocoItem {
  one: string;
  many: string;
  counts: NodeType | "node" | "import" | "process";
}

export interface DocoTemplateMeta {
  handle: string;
  label: string;
  description: string;
  item: DocoItem;
}

const NODES: DocoItem = { one: "node", many: "nodes", counts: "node" };

export const DOCO_TEMPLATES: DocoTemplateMeta[] = [
  {
    handle: "generic",
    label: "Generic (empty)",
    description: "Start with a blank doco. No rules, no node-type restrictions.",
    item: NODES,
  },
  {
    handle: "agents-chats",
    label: "Agents chats",
    description:
      "Record every chat an agent has with a user — who took part, what was asked, what was worked on, what came of it, and what was left open — one Log per chat, pointing to the decisions and work it produced.",
    item: { one: "chat", many: "chats", counts: "log" },
  },
  {
    handle: "evals",
    label: "AI evals",
    description:
      "Document and track AI test evals — what each eval measures, how it's graded, and the target — plus an append-only log of every run's score and verdict, pinned to the model and prompt versions it tested.",
    item: { one: "eval", many: "evals", counts: "eval" },
  },
  {
    handle: "architectural-decisions",
    label: "Architectural decisions (ADR)",
    description:
      "Record architecturally significant decisions (ADRs) — system structure, technology, and how data is modeled, stored, and governed — as an append-only log of context, options, choice, and consequences.",
    item: { one: "decision", many: "decisions", counts: "decision" },
  },
  {
    handle: "bugs",
    label: "Bug tracker",
    description:
      "Track software bugs as failing checks — expected vs actual behavior, steps to reproduce, severity and priority, root cause, the fix, and a regression test that turns from red to green.",
    item: { one: "bug", many: "bugs", counts: "eval" },
  },
  {
    handle: "design-decisions",
    label: "Design decisions",
    description:
      "Record design decisions — UX, interaction, and visual choices — grounded in user needs, evidence, and design principles.",
    item: { one: "decision", many: "decisions", counts: "decision" },
  },
  {
    handle: "faq",
    label: "FAQ",
    description:
      "Document frequently asked questions — a canonical question and concise answer per entry, paraphrase variants, a source of truth, and a stewarding owner — and log each result so reuse, gaps, and stale answers surface.",
    item: { one: "question", many: "questions", counts: "reference" },
  },
  {
    handle: "codebase",
    label: "GitHub codebase",
    description:
      "A copy of your GitHub repositories' code, kept in sync on every push, so it can be browsed and searched alongside your Doco knowledge.",
    item: { one: "file", many: "files", counts: "import" },
  },
  {
    handle: "github-issues",
    label: "GitHub issues",
    description:
      "Track a GitHub repository's issues — every issue syncs automatically, and closed issues retire.",
    item: { one: "issue", many: "issues", counts: "eval" },
  },
  {
    handle: "github-pull-requests",
    label: "GitHub pull requests",
    description:
      "Track a GitHub repository's pull requests as References — new PRs sync automatically, and merged PRs settle as active.",
    item: { one: "pull request", many: "pull requests", counts: "reference" },
  },
  {
    handle: "glossary",
    label: "Glossary",
    description:
      "Define a shared vocabulary — one canonical term per entry, with a concise definition, synonyms, related terms, and a stewarding owner.",
    item: { one: "term", many: "terms", counts: "reference" },
  },
  {
    handle: "ideas",
    label: "Ideas",
    description:
      "Capture and track product ideas — each separates the problem from the proposed solution, accumulates demand and evidence on one canonical record, is evaluated against explicit criteria, and ends with an honest disposition: promoted, parked, or rejected with the reason.",
    item: { one: "idea", many: "ideas", counts: "idea" },
  },
  {
    handle: "notion",
    label: "Notion workspace",
    description:
      "A read-only copy of the Notion pages and databases you share, kept in sync, so they can be searched alongside your Doco knowledge.",
    item: { one: "page", many: "pages", counts: "import" },
  },
  {
    handle: "org-chart",
    label: "Org chart",
    description:
      "Document who reports to whom — seats as roles, one solid reporting line per seat, teams, dotted-line coordination, and decision authority. Renders as an org tree.",
    item: { one: "role", many: "roles", counts: "principal" },
  },
  {
    handle: "process",
    label: "Processes",
    description:
      "Document repeatable business processes — actors, gateways, milestones, outcomes. BPMN-inspired.",
    item: { one: "process", many: "processes", counts: "process" },
  },
  {
    handle: "product-decisions",
    label: "Product decisions",
    description:
      "Record product decisions — what to build and why, for which users, with the expected impact — and revisit them as context changes.",
    item: { one: "decision", many: "decisions", counts: "decision" },
  },
  {
    handle: "product-roadmap",
    label: "Product roadmap",
    description:
      "Document outcome-oriented product bets over Now / Next / Later horizons — each with an owner, a measurable target, and a result that closes the loop on whether it worked.",
    item: { one: "bet", many: "bets", counts: "intent" },
  },
  {
    handle: "slack",
    label: "Slack workspace",
    description:
      "A read-only copy of a Slack workspace's public channels, kept in sync, so its conversations can be searched alongside your Doco knowledge.",
    item: { one: "message", many: "messages", counts: "import" },
  },
  {
    handle: "test-scenarios",
    label: "Test scenarios",
    description:
      "Document test scenarios for websites and apps and log every run — each scenario captures preconditions, steps, and the expected result; each run records the environment, outcome, and evidence.",
    item: { one: "scenario", many: "scenarios", counts: "eval" },
  },
];

/** Look up a single template by handle (used to re-render label/desc
 * on the wizard step-3 page when carried through via URL param). */
export function findDocoTemplateMeta(handle: string): DocoTemplateMeta | undefined {
  return DOCO_TEMPLATES.find((t) => t.handle === handle);
}

/** The thing a Doco made from this template holds. A Doco with no known
 *  template holds plain nodes, like a Generic one. */
export function docoItemFor(template: string | null): DocoItem {
  return (template && findDocoTemplateMeta(template)?.item) || NODES;
}

/** "52,500 pull requests", "1 bug": a Doco's count of the thing it holds. */
export function countDocoItems(count: number, template: string | null): string {
  const item = docoItemFor(template);
  return `${count.toLocaleString("en-US")} ${count === 1 ? item.one : item.many}`;
}
