import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "guidance_policies",
  entityType: "guidance_policy",
  pluralDir: "guidance_policies",
});

export const loader = route.loader;
export const action = route.action;
