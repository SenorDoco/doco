import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "ideas",
  nodeType: "idea",
  pluralDir: "ideas",
});

export const loader = route.loader;
export const action = route.action;
