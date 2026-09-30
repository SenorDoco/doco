// Shared template metadata used by the /new-doco wizard, the agent recipes
// and the Doco type icons (components/doco-type-icon.tsx). The handles must
// match the ones the host package's `findDocoTemplateByName` knows about —
// they're passed verbatim to `createDocoInWorkspace`.

export interface DocoTemplateMeta {
  handle: string;
  label: string;
  description: string;
}

export const DOCO_TEMPLATES: DocoTemplateMeta[] = [
  {
    handle: "generic",
    label: "Generic (empty)",
    description: "Start with a blank doco. No rules, no node-type restrictions.",
  },
  {
    handle: "process",
    label: "Processes",
    description:
      "Document repeatable business processes — actors, gateways, milestones, outcomes. BPMN-inspired.",
  },
  {
    handle: "github-pull-requests",
    label: "GitHub pull requests",
    description:
      "Track a GitHub repository's pull requests as References — new PRs sync automatically, and merged PRs settle as active.",
  },
  {
    handle: "codebase",
    label: "GitHub codebase",
    description:
      "A copy of your GitHub repositories' code, kept in sync on every push, so it can be browsed and searched alongside your Doco knowledge.",
  },
  {
    handle: "slack",
    label: "Slack workspace",
    description:
      "A read-only copy of a Slack workspace's public channels, kept in sync, so its conversations can be searched alongside your Doco knowledge.",
  },
  {
    handle: "notion",
    label: "Notion workspace",
    description:
      "A read-only copy of the Notion pages and databases you share, kept in sync, so they can be searched alongside your Doco knowledge.",
  },
  {
    handle: "architectural-decisions",
    label: "Architectural decisions (ADR)",
    description:
      "Record architecturally significant decisions (ADRs) — system structure, technology, and how data is modeled, stored, and governed — as an append-only log of context, options, choice, and consequences.",
  },
  {
    handle: "product-decisions",
    label: "Product decisions",
    description:
      "Record product decisions — what to build and why, for which users, with the expected impact — and revisit them as context changes.",
  },
  {
    handle: "design-decisions",
    label: "Design decisions",
    description:
      "Record design decisions — UX, interaction, and visual choices — grounded in user needs, evidence, and design principles.",
  },
  {
    handle: "glossary",
    label: "Glossary",
    description:
      "Define a shared vocabulary — one canonical term per entry, with a concise definition, synonyms, related terms, and a stewarding owner.",
  },
  {
    handle: "org-chart",
    label: "Org chart",
    description:
      "Document who reports to whom — seats as roles, one solid reporting line per seat, teams, dotted-line coordination, and decision authority. Renders as an org tree.",
  },
  {
    handle: "evals",
    label: "AI evals",
    description:
      "Document and track AI test evals — what each eval measures, how it's graded, and the target — plus an append-only log of every run's score and verdict, pinned to the model and prompt versions it tested.",
  },
  {
    handle: "product-roadmap",
    label: "Product roadmap",
    description:
      "Document outcome-oriented product bets over Now / Next / Later horizons — each with an owner, a measurable target, and a result that closes the loop on whether it worked.",
  },
  {
    handle: "test-scenarios",
    label: "Test scenarios",
    description:
      "Document test scenarios for websites and apps and log every run — each scenario captures preconditions, steps, and the expected result; each run records the environment, outcome, and evidence.",
  },
  {
    handle: "faq",
    label: "FAQ",
    description:
      "Document frequently asked questions — a canonical question and concise answer per entry, paraphrase variants, a source of truth, and a stewarding owner — and log each result so reuse, gaps, and stale answers surface.",
  },
  {
    handle: "bugs",
    label: "Bug tracker",
    description:
      "Track software bugs as failing checks — expected vs actual behavior, steps to reproduce, severity and priority, root cause, the fix, and a regression test that turns from red to green.",
  },
  {
    handle: "ideas",
    label: "Ideas",
    description:
      "Capture and track product ideas — each separates the problem from the proposed solution, accumulates demand and evidence on one canonical record, is evaluated against explicit criteria, and ends with an honest disposition: promoted, parked, or rejected with the reason.",
  },
  {
    handle: "agents-chats",
    label: "Agents chats",
    description:
      "Record every chat an agent has with a user — who took part, what was asked, what was worked on, what came of it, and what was left open — one Log per chat, pointing to the decisions and work it produced.",
  },
];

/** Look up a single template by handle (used to re-render label/desc
 * on the wizard step-3 page when carried through via URL param). */
export function findDocoTemplateMeta(handle: string): DocoTemplateMeta | undefined {
  return DOCO_TEMPLATES.find((t) => t.handle === handle);
}
