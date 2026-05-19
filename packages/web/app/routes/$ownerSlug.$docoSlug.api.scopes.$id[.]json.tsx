import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "scopes",
  nodeType: "scope",
  pluralDir: "scopes",
  // Per decision_01KRYECEA32SRSQCKFXSDCBK67 a scope's description text
  // lives on `summary`, and `allowed_node_types` is the generic
  // capture-restriction attribute. `name` stays editable for scope
  // renames; the legacy `purpose` / `guidelines` fields are retired —
  // captures of the former go straight to `summary` now.
  allowedFields: ["name", "summary", "allowed_node_types"],
});

export const loader = route.loader;
export const action = route.action;
