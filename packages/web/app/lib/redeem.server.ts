// Server-only re-export. Keeps `@doco/api`'s server-only chain (better-sqlite3,
// hono, etc.) out of the client bundle. See lib/tokens.server.ts.
export { redeemInvitation, findPrincipalById, addAgentPrincipal, suggestScopes } from "@doco/api";
export type {
  RedemptionResult,
  RedemptionError,
  RedemptionBody,
  ScopeSuggestion,
  SuggestScopesOptions,
} from "@doco/api";
export {
  createDocoInHost,
  createScopeInDoco,
  materializeScopeTree,
  migrateScopesInDoco,
  parseScopeNamesInput,
  readScopeWatchedInDoco,
  renameDocoSlug,
  setScopeWatchedInDoco,
  softDeleteDoco,
  updateDocoMeta,
  updateScopeInDoco,
} from "@doco/host";
import { reindex as reindexBare, type BuildReport } from "@doco/index";
import { getDocoEmbeddingProvider } from "./embedding-provider.server";

/**
 * Reindex wrapper that auto-attaches the active embedding provider
 * (ADR-052). Falls back to embedding-less reindex when no provider is
 * configured (no OPENAI_API_KEY). Every web-app reindex call site funnels
 * through here so embeddings stay in sync with the index.
 */
export function reindex(docoRoot: string): Promise<BuildReport> {
  const embeddingProvider = getDocoEmbeddingProvider();
  return reindexBare(docoRoot, embeddingProvider ? { embeddingProvider } : {});
}
