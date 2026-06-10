import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "actions",
  nodeType: "action",
  pluralDir: "actions",
});

export const loader = route.loader;
export const action = route.action;
