import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "scopes",
  nodeType: "scope",
  pluralDir: "scopes",
  allowedFields: ["name", "purpose", "guidelines"],
});

export const loader = route.loader;
export const action = route.action;
