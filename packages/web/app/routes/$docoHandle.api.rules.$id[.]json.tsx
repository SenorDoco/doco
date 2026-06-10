import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "rules",
  nodeType: "rule",
  pluralDir: "rules",
});

export const loader = route.loader;
export const action = route.action;
