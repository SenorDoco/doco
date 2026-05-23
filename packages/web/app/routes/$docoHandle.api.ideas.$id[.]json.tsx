import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "ideas",
  entityType: "idea",
  pluralDir: "ideas",
  allowedFields: [
    "idea",
    "proposer_id",
    "promoted_to",
    "rejection_reason",
    "lifecycle",
    "deprecated",
    "outcome",
  ],
});

export const loader = route.loader;
export const action = route.action;
