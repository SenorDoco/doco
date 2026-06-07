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
    label: "Process",
    description:
      "Document repeatable business processes — actors, gateways, milestones, outcomes. BPMN-inspired.",
    updatedAt: "2026-06-05",
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
    handle: "architectural-decisions",
    label: "Architectural decisions (ADR)",
    description:
      "Record architecturally significant decisions (ADRs) — context, options, choice, and consequences — as an append-only log.",
    updatedAt: "2026-06-07",
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
    handle: "data-decisions",
    label: "Data decisions",
    description:
      "Record data decisions — models, schema, storage, pipelines, governance, and retention — with lineage and compliance impact.",
    updatedAt: "2026-06-07",
    owner: TEMPLATE_OWNER,
  },
];

/** Look up a single template by handle (used to re-render label/desc
 * on the wizard step-3 page when carried through via URL param). */
export function findDocoTemplateMeta(handle: string): DocoTemplateMeta | undefined {
  return DOCO_TEMPLATES.find((t) => t.handle === handle);
}
