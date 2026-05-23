import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "intents",
  entityType: "intent",
  pluralDir: "intents",
  allowedFields: ["slug", "intent", "wanted_by", "actors", "stakeholders", "lifecycle"],
});

export const loader = route.loader;
export const action = route.action;
