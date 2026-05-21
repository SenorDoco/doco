// Shared template metadata used by the /new-doco wizard step 3 AND
// the /dashboard "Newly available templates" panel. The handles must
// match the ones the host package's `findDocoTemplateByName` knows
// about — they're passed verbatim to `createDocoInOrg`.
//
// `addedAt` is the ISO date the template first shipped on the host;
// the dashboard sorts the panel by this descending and renders
// `timeAgo(addedAt)` next to each entry. Add a new template? Bump
// the date on the same commit so it surfaces as "added Ns ago" until
// the next one ships.

export interface DocoTemplateMeta {
  handle: string;
  label: string;
  description: string;
  /** ISO-8601 date the template first shipped. */
  addedAt: string;
  /** Author label rendered under the template card on the dashboard. */
  creator: string;
}

export const DOCO_TEMPLATES: DocoTemplateMeta[] = [
  {
    handle: "generic",
    label: "Generic (empty)",
    description: "Start with a blank doco. No rules, no node-type restrictions.",
    addedAt: "2026-01-01",
    creator: "Doco",
  },
  {
    handle: "user-flows",
    label: "User Flows",
    description: "Document end-to-end user journeys as steps, branches, and decisions.",
    addedAt: "2026-02-15",
    creator: "Doco",
  },
  {
    handle: "state-machines",
    label: "State Machines",
    description: "Formal state-machine modeling — states, transitions, invariants.",
    addedAt: "2026-03-10",
    creator: "Doco",
  },
  {
    handle: "business-processes",
    label: "Business Processes",
    description:
      "Document repeatable business processes — actors, gateways, milestones, outcomes. BPMN-inspired.",
    addedAt: "2026-05-08",
    creator: "Doco",
  },
  {
    handle: "test",
    label: "Test",
    description:
      "Executable tests inspired by TDD and AI evals. Each Eval pins one checkable claim about a decision, article, or action.",
    addedAt: "2026-05-12",
    creator: "Doco",
  },
];

/** Look up a single template by handle (used to re-render label/desc
 * on the wizard step-3 page when carried through via URL param). */
export function findDocoTemplateMeta(handle: string): DocoTemplateMeta | undefined {
  return DOCO_TEMPLATES.find((t) => t.handle === handle);
}
