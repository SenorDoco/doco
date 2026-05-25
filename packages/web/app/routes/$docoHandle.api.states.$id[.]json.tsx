import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "states",
  entityType: "state",
  pluralDir: "states",
  allowedFields: ["kind", "invariants", "preceded_by"],
});

export const loader = route.loader;
export const action = route.action;
