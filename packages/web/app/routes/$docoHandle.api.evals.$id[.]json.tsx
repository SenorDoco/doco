import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "evals",
  entityType: "eval",
  pluralDir: "evals",
  allowedFields: [
    "name",
    "criterion",
    "kind",
    "description",
    "expected_status",
    "how_to_run",
    "input",
    "expected",
    "target_ref",
  ],
});

export const loader = route.loader;
export const action = route.action;
