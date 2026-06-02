// Server-only re-exports. Keeps server-only dependencies (pg, etc.) out of
// the client bundle.
import { createDocoInWorkspace as createHostDocoInWorkspace } from "@doco/host";

export {
  addWorkspaceByHandle,
  ensurePersonalWorkspace,
  findAvailableDocoHandle,
  findAvailableWorkspaceHandle,
  findDocoTemplate,
  renameDocoHandle,
  softDeleteDoco,
  updateDocoMeta,
} from "@doco/host";
import { type BuildReport, reindex as reindexBare } from "@doco/index";
import { getDocoEmbeddingProvider } from "./embedding-provider.server";
import { recordReindexLoad } from "./telemetry.server";

type CreateDocoInWorkspaceOptions = Parameters<typeof createHostDocoInWorkspace>[0];
type CreatedDocoInWorkspace = Awaited<ReturnType<typeof createHostDocoInWorkspace>>;

export async function createDocoInWorkspace(
  opts: CreateDocoInWorkspaceOptions,
): Promise<CreatedDocoInWorkspace> {
  return await createHostDocoInWorkspace(opts);
}

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
 * `docoId` is required. Route loaders resolve it from Postgres before
 * write handlers call into indexing.
 *
 * `changedEntityIds` triggers the incremental path: only those entities'
 * derived rows are rebuilt, the rest of the Doco's edges/FTS/embeddings
 * stay in place. Used by single-entity capture/patch handlers. Omit
 * for full rebuilds — first build, bulk import, settings.
 *
 * `extra.skipEmbeddings` / `extra.skipStructural` split the two phases —
 * capture flow runs structural inline and embeddings in `waitUntil`.
 */
export async function reindex(
  docoId: string,
  changedEntityIds?: string[],
  extra?: ReindexExtraOptions,
): Promise<BuildReport> {
  const embeddingProvider = getDocoEmbeddingProvider();
  const opts = {
    ...(embeddingProvider ? { embeddingProvider } : {}),
    docoId,
    ...(changedEntityIds && changedEntityIds.length > 0 ? { changedEntityIds } : {}),
    ...(extra?.skipEmbeddings ? { skipEmbeddings: true } : {}),
    ...(extra?.skipStructural ? { skipStructural: true } : {}),
  };
  const report = await reindexBare(opts);
  // Bubble the load cost into the active capture-telemetry context so the
  // per-capture row records how much time the reindex spent reading rows
  // vs. doing actual work. No-op outside capture (CLI reindex, etc.).
  recordReindexLoad(report.loadMs, report.loadedEntityCount);
  return report;
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
  docoId: string,
  changedEntityIds?: string[],
): Promise<BuildReport> {
  return reindex(docoId, changedEntityIds, { skipStructural: true });
}
