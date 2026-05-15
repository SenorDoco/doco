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
 *
 * `docoId` is optional: when the caller already holds it (capture/patch
 * handlers, scope edits), pass it to skip the on-disk `doco.yaml` read.
 * Postgres-backed serverless deploys have no persistent filesystem, so
 * a missing yaml otherwise throws and silently breaks edge/FTS rebuild.
 */
export function reindex(docoRoot: string, docoId?: string): Promise<BuildReport> {
  const embeddingProvider = getDocoEmbeddingProvider();
  const opts = {
    ...(embeddingProvider ? { embeddingProvider } : {}),
    ...(docoId ? { docoId } : {}),
  };
  return reindexBare(docoRoot, opts);
}
