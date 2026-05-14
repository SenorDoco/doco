import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "references",
  nodeType: "reference",
  pluralDir: "references",
  allowedFields: ["slug", "ref_type", "locator", "citation", "title"],
});

export const loader = route.loader;
export const action = route.action;
