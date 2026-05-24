import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

// PATCH on a Log freezes most fields (mutability gate: logs are frozen
// from creation, like References). Only lifecycle, supersession, and
// additive list operations survive — see mutability.server.ts.
const route = makeUpdateRoute({
  type: "logs",
  entityType: "log",
  pluralDir: "logs",
  allowedFields: [
    "slug",
    "verb",
    "outputs",
    "preceded_by",
    "decision_ids",
    "actor_id",
    "happened_at",
    "template_id",
  ],
});

export const loader = route.loader;
export const action = route.action;
