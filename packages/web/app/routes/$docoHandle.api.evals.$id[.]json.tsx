import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "evals",
  entityType: "eval",
  pluralDir: "evals",
});

export const loader = route.loader;
export const action = route.action;
