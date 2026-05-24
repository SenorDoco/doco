import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "neuron_authoring_policies",
  entityType: "neuron_authoring_policy",
  pluralDir: "neuron_authoring_policies",
  allowedFields: [
    "summary",
    "body_md",
    "lifecycle",
    "born_from",
    "predicate",
    "evaluation_kind",
    "fires_when_neuron_lifecycle",
    "on_violation",
  ],
});

export const loader = route.loader;
export const action = route.action;
