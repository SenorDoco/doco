import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "neuron_authoring_policies",
  entityType: "neuron_authoring_policy",
  pluralDir: "neuron_authoring_policies",
});

export const loader = route.loader;
export const action = route.action;
