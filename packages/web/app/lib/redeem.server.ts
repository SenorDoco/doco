// Server-only re-export. Keeps server-only dependencies (pg, etc.) out of
// the client bundle. See lib/tokens.server.ts.
export { addAgentPrincipal } from "./agents.server";
export { suggestScopes } from "./llm.server";
export type {
  ScopeSuggestion,
  SuggestScopesOptions,
} from "./llm.server";
export {
  createDocoInHost,
  createRuleInDoco,
  createScopeInDoco,
  materializeScopeTree,
  migrateScopesInDoco,
  parseScopeNamesInput,
  readScopeWatchedInDoco,
  renameDocoSlug,
  seedScopeFromTemplate,
  setScopeWatchedInDoco,
  softDeleteDoco,
  updateDocoMeta,
  updateScopeInDoco,
} from "@doco/host";
import { type BuildReport, reindex as reindexBare } from "@doco/index";
import { getDocoEmbeddingProvider } from "./embedding-provider.server";
import { readDocoMetadata } from "./scope-helpers.server";

export interface ReindexExtraOptions {
  /** Skip the OpenAI embedding pass (FTS + edges only). */
  skipEmbeddings?: boolean;
  /** Skip the structural FTS + edges pass (embeddings only). */
  skipStructural?: boolean;
}

/**
 * Reindex wrapper that auto-attaches the active embedding provider
 * (ADR-052). Falls back to embedding-less reindex when no provider is
 * configured (no OPENAI_API_KEY). Every web-app reindex call site funnels
 * through here so embeddings stay in sync with the index.
 *
 * `docoId` is optional: when the caller already holds it (capture/patch
 * handlers, scope edits), pass it directly. Otherwise this wrapper resolves
 * the id from the synthetic `<root>/docos/<owner>/<slug>` path.
 *
 * `changedEntityIds` triggers the incremental path: only those entities'
 * derived rows are rebuilt, the rest of the Doco's edges/FTS/embeddings
 * stay in place. Used by single-entity capture/patch handlers. Omit
 * for full rebuilds — first build, scope rename, bulk import, settings.
 *
 * `extra.skipEmbeddings` / `extra.skipStructural` split the two phases —
 * capture flow runs structural inline and embeddings in `waitUntil`.
 */
export async function reindex(
  docoRoot: string,
  docoId?: string,
  changedEntityIds?: string[],
  extra?: ReindexExtraOptions,
): Promise<BuildReport> {
  const embeddingProvider = getDocoEmbeddingProvider();
  // Resolve from the docoRoot's slug pair so callers that hold only the
  // synthetic dir path still work.
  let resolvedDocoId = docoId;
  if (!resolvedDocoId) {
    const meta = await readDocoMetadata(docoRoot);
    if (meta) resolvedDocoId = meta.docoId;
  }
  const opts = {
    ...(embeddingProvider ? { embeddingProvider } : {}),
    ...(resolvedDocoId ? { docoId: resolvedDocoId } : {}),
    ...(changedEntityIds && changedEntityIds.length > 0 ? { changedEntityIds } : {}),
    ...(extra?.skipEmbeddings ? { skipEmbeddings: true } : {}),
    ...(extra?.skipStructural ? { skipStructural: true } : {}),
  };
  return reindexBare(docoRoot, opts);
}

/**
 * Shorthand for the "second phase" reindex — runs only the embedding
 * pass, leaving FTS + edges untouched. Used by capture flows that
 * already ran the structural pass inline and now want the embeddings
 * to catch up off the request path (`waitUntil`).
 *
 * No-op when no embedding provider is configured.
 */
export function reindexEmbeddingsOnly(
  docoRoot: string,
  docoId?: string,
  changedEntityIds?: string[],
): Promise<BuildReport> {
  return reindex(docoRoot, docoId, changedEntityIds, { skipStructural: true });
}
