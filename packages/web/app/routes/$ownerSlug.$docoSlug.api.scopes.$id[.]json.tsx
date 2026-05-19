import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "scopes",
  nodeType: "scope",
  pluralDir: "scopes",
  // Scope nodes expose `purpose` for their description text;
  // `allowed_node_types` is the generic capture-restriction attribute.
  // `name` stays editable for scope renames.
  allowedFields: ["name", "purpose", "allowed_node_types"],
});

export const loader = route.loader;
export const action = route.action;
