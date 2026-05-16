import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "rules",
  nodeType: "rule",
  pluralDir: "rules",
  allowedFields: [
    "slug",
    "kind",
    "predicate",
    "modality",
    "severity",
    "phase",
    "expected",
    "on_violation",
    "applies_to",
  ],
});

export const loader = route.loader;
export const action = route.action;
