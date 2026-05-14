import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "reasoning",
  nodeType: "reasoning",
  pluralDir: "reasoning",
  allowedFields: ["slug", "conclusion_ref"],
});

export const loader = route.loader;
export const action = route.action;
