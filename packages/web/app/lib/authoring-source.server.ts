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

async function oauthMetadata(token: string): Promise<Record<string, unknown>> {
  const { validateAccessToken } = await import("./oauth-server.server");
  const record = await validateAccessToken(token);
  const metadata: Record<string, unknown> = { auth: "oauth" };
  const tokenName = record?.token_name?.trim();
  const clientName = record?.client_name?.trim();
  if (tokenName) metadata.token_name = tokenName;
  if (clientName) metadata.client_name = clientName;
  return metadata;
}

export async function authoringContextForRequest(request: Request): Promise<AuthoringWriteContext> {
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
    return { source: "api", metadata: await oauthMetadata(bearer) };
  }
  if (bearer) {
    return { source: "api", metadata: { auth: "bearer" } };
  }

  return { source: "ui", metadata: { surface: "website" } };
}
