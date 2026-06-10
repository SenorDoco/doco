import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "intents",
  nodeType: "intent",
  pluralDir: "intents",
});

export const loader = route.loader;
export const action = route.action;
