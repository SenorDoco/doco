import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "actions",
  entityType: "action",
  pluralDir: "actions",
  allowedFields: ["slug", "verb", "outputs", "follows", "decision_ids", "actor_id", "performed_at"],
});

export const loader = route.loader;
export const action = route.action;
