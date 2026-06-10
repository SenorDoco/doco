import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "states",
  nodeType: "state",
  pluralDir: "states",
});

export const loader = route.loader;
export const action = route.action;
