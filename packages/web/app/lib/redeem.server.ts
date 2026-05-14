// Server-only re-export. Keeps server-only dependencies (pg, etc.) out of
// the client bundle. See lib/tokens.server.ts.
export { findPrincipalById, addAgentPrincipal } from "./agents.server";
export { suggestScopes } from "./llm.server";
export type {
  ScopeSuggestion,
  SuggestScopesOptions,
} from "./llm.server";
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
