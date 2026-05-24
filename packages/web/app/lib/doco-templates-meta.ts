// Shared template metadata used by the /new-doco wizard step 3 AND
// the /dashboard "Newly available templates" panel. The handles must
// match the ones the host package's `findDocoTemplateByName` knows
// about — they're passed verbatim to `createDocoInOrg`.
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
    description: "Start with a blank doco. No rules, no neuron-type restrictions.",
    updatedAt: "2026-01-01",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "user-flows",
    label: "User Flows",
    description: "Document end-to-end user journeys as steps, branches, and decisions.",
    updatedAt: "2026-02-15",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "state-machines",
    label: "State Machines",
    description: "Formal state-machine modeling — states, transitions, invariants.",
    updatedAt: "2026-03-10",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "business-processes",
    label: "Business Processes",
    description:
      "Document repeatable business processes — actors, gateways, milestones, outcomes. BPMN-inspired.",
    updatedAt: "2026-05-08",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "test",
    label: "Tests",
    description:
      "Executable tests inspired by TDD and AI evals. Each Eval pins one checkable claim about a decision, policy, or action.",
    updatedAt: "2026-05-12",
    owner: TEMPLATE_OWNER,
  },
  {
    handle: "org-chart",
    label: "Org Chart",
    description:
      "Map the people and AI agents in an organization — reporting lines, teams, and appointments. Every member must declare whether they're a person or an AI agent.",
    updatedAt: "2026-05-24",
    owner: TEMPLATE_OWNER,
  },
];

/** Look up a single template by handle (used to re-render label/desc
 * on the wizard step-3 page when carried through via URL param). */
export function findDocoTemplateMeta(handle: string): DocoTemplateMeta | undefined {
  return DOCO_TEMPLATES.find((t) => t.handle === handle);
}
