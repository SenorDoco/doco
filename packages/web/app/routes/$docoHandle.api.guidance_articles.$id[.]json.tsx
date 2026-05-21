import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "guidance_articles",
  nodeType: "guidance_article",
  pluralDir: "guidance_articles",
  allowedFields: ["summary", "body_md", "lifecycle", "born_from"],
});

export const loader = route.loader;
export const action = route.action;
