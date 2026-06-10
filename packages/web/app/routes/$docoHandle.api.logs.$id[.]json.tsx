import { makeUpdateRoute } from "~/lib/api-capture-factory.server";

// PATCH on a Log is a generic node update: every field except
// system-managed identity/audit columns is patchable (see
// makeUpdateRoute and capture.server.ts).
const route = makeUpdateRoute({
  type: "logs",
  nodeType: "log",
  pluralDir: "logs",
});

export const loader = route.loader;
export const action = route.action;
