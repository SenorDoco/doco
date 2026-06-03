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
    handle: "business-processes",
    label: "Business Processes",
    description:
      "Document repeatable business processes — actors, gateways, milestones, outcomes. BPMN-inspired.",
    updatedAt: "2026-05-26",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "glossaries",
    label: "Glossaries",
    description:
      "Document product and domain terminology — canonical terms, definitions, aliases, replacement links, sources, and consistency checks.",
    updatedAt: "2026-06-01",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "architectural-decisions",
    label: "Architectural Decisions",
    description:
      "Document architectural decision records — system structure, interfaces, infrastructure, quality attributes, constraints, alternatives, and consequences.",
    updatedAt: "2026-06-03",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "product-decisions",
    label: "Product Decisions",
    description:
      "Document product decision records — user/customer evidence, scope, positioning, pricing, roadmap choices, success metrics, alternatives, and revisit triggers.",
    updatedAt: "2026-06-03",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "design-decisions",
    label: "Design Decisions",
    description:
      "Document design decision records — UX, service, interaction, content, accessibility, design-system, and research-backed trade-offs.",
    updatedAt: "2026-06-03",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "data-decisions",
    label: "Data Decisions",
    description:
      "Document data decision records — source-of-truth choices, schemas, contracts, metric definitions, governance, quality, lineage, retention, privacy, and access.",
    updatedAt: "2026-06-03",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "org-chart",
    label: "Org Chart",
    description:
      "Map the people and AI agents in an organization — reporting lines, teams, roles, and appointments. Every seat declares whether it's filled by a person, filled by an AI agent, or currently vacant.",
    updatedAt: "2026-05-30",
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
];

/** Look up a single template by handle (used to re-render label/desc
 * on the wizard step-3 page when carried through via URL param). */
export function findDocoTemplateMeta(handle: string): DocoTemplateMeta | undefined {
  return DOCO_TEMPLATES.find((t) => t.handle === handle);
}
