import type { CommitSource } from "@doco/db";
import { extractBearer } from "./session.server";

export const AUTHORING_SURFACE_HEADER = "x-doco-authoring-surface";

export interface AuthoringWriteContext {
  source: CommitSource;
  metadata: Record<string, unknown> | null;
}

function userAgentSurface(userAgent: string): AuthoringWriteContext | null {
  if (/Doco-In-Page-Assistant/i.test(userAgent)) {
    return { source: "ui", metadata: { surface: "senor_doco", client: "website" } };
  }
  if (/Doco-Slack-Assistant/i.test(userAgent)) {
    return { source: "slack", metadata: { surface: "slack" } };
  }
  return null;
}

export function authoringContextForRequest(request: Request): AuthoringWriteContext {
  const explicitSurface = request.headers.get(AUTHORING_SURFACE_HEADER)?.trim().toLowerCase();
  if (explicitSurface === "senor-doco-web") {
    return { source: "ui", metadata: { surface: "senor_doco", client: "website" } };
  }
  if (explicitSurface === "slack") {
    return { source: "slack", metadata: { surface: "slack" } };
  }
  if (explicitSurface === "mcp") {
    return { source: "mcp", metadata: { surface: "mcp" } };
  }

  const uaContext = userAgentSurface(request.headers.get("user-agent") ?? "");
  if (uaContext) return uaContext;

  const bearer = extractBearer(request);
  if (bearer?.startsWith("doco_at_")) {
    return { source: "api", metadata: { auth: "oauth" } };
  }
  if (bearer) {
    return { source: "api", metadata: { auth: "bearer" } };
  }

  return { source: "ui", metadata: { surface: "website" } };
}
