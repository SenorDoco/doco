import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "guidance_policies",
  entityType: "guidance_policy",
  pluralDir: "guidance_policies",
  allowedFields: ["summary", "body_md", "lifecycle", "born_from"],
});

export const loader = route.loader;
export const action = route.action;
