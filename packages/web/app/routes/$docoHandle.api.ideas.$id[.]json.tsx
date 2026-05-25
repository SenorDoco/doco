import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "ideas",
  entityType: "idea",
  pluralDir: "ideas",
});

export const loader = route.loader;
export const action = route.action;
