import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "guidance_primitives",
  entityType: "guidance_primitive",
  pluralDir: "guidance_primitives",
  allowedFields: ["summary", "body_md", "lifecycle", "born_from"],
});

export const loader = route.loader;
export const action = route.action;
