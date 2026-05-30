import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "node_authoring_policies",
  entityType: "node_authoring_policy",
  pluralDir: "node_authoring_policies",
});

export const loader = route.loader;
export const action = route.action;
