import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "node_authoring_articles",
  nodeType: "node_authoring_article",
  pluralDir: "node_authoring_articles",
  allowedFields: [
    "summary",
    "body_md",
    "lifecycle",
    "born_from",
    "predicate",
    "evaluation_kind",
    "fires_when_node_lifecycle",
    "on_violation",
  ],
});

export const loader = route.loader;
export const action = route.action;
