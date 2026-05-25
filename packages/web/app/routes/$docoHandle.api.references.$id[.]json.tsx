import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "references",
  entityType: "reference",
  pluralDir: "references",
});

export const loader = route.loader;
export const action = route.action;
