import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "actions",
  nodeType: "action",
  pluralDir: "actions",
  allowedFields: [
    "slug",
    "verb",
    "outputs",
    "follows",
    "decision_ids",
    "performed_by",
    "performed_at",
  ],
});

export const loader = route.loader;
export const action = route.action;
