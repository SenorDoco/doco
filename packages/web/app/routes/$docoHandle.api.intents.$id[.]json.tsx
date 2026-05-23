import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "intents",
  entityType: "intent",
  pluralDir: "intents",
  allowedFields: [
    "slug",
    "title",
    "wanted_by",
    "actors",
    "stakeholders",
    "lifecycle",
    "summary",
    "body_md",
  ],
});

export const loader = route.loader;
export const action = route.action;
