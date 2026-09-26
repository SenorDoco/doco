// Shared template metadata used by the /new-doco wizard step 3 AND
// the /dashboard "Newly available templates" panel. The handles must
// match the ones the host package's `findDocoTemplateByName` knows
// about — they're passed verbatim to `createDocoInWorkspace`.
//
// `updatedAt` is the ISO date the template metadata last changed on
// the host; the dashboard sorts the panel by this descending and
// renders a stable "Last updated ..." label next to each entry. Add or
// revise a template? Bump the date on the same commit.

export interface DocoTemplateMeta {
  handle: string;
  label: string;
  description: string;
  /** ISO-8601 date the template metadata last changed. */
  updatedAt: string;
  /** Owner label rendered under the template card on the dashboard. */
  owner: string;
}

const TEMPLATE_OWNER = "@torrenegra";

export const DOCO_TEMPLATES: DocoTemplateMeta[] = [
  {
    handle: "generic",
    label: "Generic (empty)",
    description: "Start with a blank doco. No rules, no node-type restrictions.",
    updatedAt: "2026-01-01",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "process",
    label: "Processes",
    description:
      "Document repeatable business processes — actors, gateways, milestones, outcomes. BPMN-inspired.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "github-pull-requests",
    label: "GitHub pull requests",
    description:
      "Track a GitHub repository's pull requests as References — new PRs sync automatically, and merged PRs settle as active.",
    updatedAt: "2026-05-31",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "slack",
    label: "Slack workspace",
    description:
      "A read-only copy of a Slack workspace's public channels, kept in sync, so its conversations can be searched alongside your Doco knowledge.",
    updatedAt: "2026-09-26",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "architectural-decisions",
    label: "Architectural decisions (ADR)",
    description:
      "Record architecturally significant decisions (ADRs) — system structure, technology, and how data is modeled, stored, and governed — as an append-only log of context, options, choice, and consequences.",
    updatedAt: "2026-06-13",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "product-decisions",
    label: "Product decisions",
    description:
      "Record product decisions — what to build and why, for which users, with the expected impact — and revisit them as context changes.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "design-decisions",
    label: "Design decisions",
    description:
      "Record design decisions — UX, interaction, and visual choices — grounded in user needs, evidence, and design principles.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "glossary",
    label: "Glossary",
    description:
      "Define a shared vocabulary — one canonical term per entry, with a concise definition, synonyms, related terms, and a stewarding owner.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "org-chart",
    label: "Org chart",
    description:
      "Document who reports to whom — seats as roles, one solid reporting line per seat, teams, dotted-line coordination, and decision authority. Renders as an org tree.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "evals",
    label: "AI evals",
    description:
      "Document and track AI test evals — what each eval measures, how it's graded, and the target — plus an append-only log of every run's score and verdict, pinned to the model and prompt versions it tested.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "product-roadmap",
    label: "Product roadmap",
    description:
      "Document outcome-oriented product bets over Now / Next / Later horizons — each with an owner, a measurable target, and a result that closes the loop on whether it worked.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "test-scenarios",
    label: "Test scenarios",
    description:
      "Document test scenarios for websites and apps and log every run — each scenario captures preconditions, steps, and the expected result; each run records the environment, outcome, and evidence.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "faq",
    label: "FAQ",
    description:
      "Document frequently asked questions — a canonical question and concise answer per entry, paraphrase variants, a source of truth, and a stewarding owner — and log each result so reuse, gaps, and stale answers surface.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "bugs",
    label: "Bug tracker",
    description:
      "Track software bugs as failing checks — expected vs actual behavior, steps to reproduce, severity and priority, root cause, the fix, and a regression test that turns from red to green.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "ideas",
    label: "Ideas",
    description:
      "Capture and track product ideas — each separates the problem from the proposed solution, accumulates demand and evidence on one canonical record, is evaluated against explicit criteria, and ends with an honest disposition: promoted, parked, or rejected with the reason.",
    updatedAt: "2026-06-11",
    owner: TEMPLATE_OWNER,
  },
];

/** Look up a single template by handle (used to re-render label/desc
 * on the wizard step-3 page when carried through via URL param). */
export function findDocoTemplateMeta(handle: string): DocoTemplateMeta | undefined {
  return DOCO_TEMPLATES.find((t) => t.handle === handle);
}
