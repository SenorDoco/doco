import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

const route = makeUpdateRoute({
  type: "pull_requests",
  entityType: "pull_request",
  pluralDir: "pull_requests",
});

export const loader = route.loader;
export const action = route.action;
