// Server-only business logic for the /<owner>/<doco>/api/settings.json
// endpoint. Lives in a `.server.ts` so the bundler keeps it out of the
// client.
import { validateDocoSlug } from "@doco/shared";
import { rootDir } from "./db.server";
import { reindex, renameDocoSlug, updateDocoMeta } from "./redeem.server";
import { readDocoMetadata } from "./scope-helpers.server";

export interface SettingsPatch {
  slug?: string;
  display_name?: string | null;
  description?: string | null;
  visibility?: "private" | "public";
}

export interface ApplySettingsArgs {
  ownerSlug: string;
  docoSlug: string;
  oldDir: string;
  patch: SettingsPatch;
}

export interface ApplySettingsResult {
  ok: true;
  finalSlug: string;
  display_name: string;
  description: string;
  visibility: "private" | "public";
  doco_id: string | null;
}

/**
 * Apply a settings patch. Validates the slug, renames the Doco directory
 * if the slug changed, updates doco.yaml metadata, reindexes, and returns
 * the new public settings.
 */
export async function applyDocoSettings(args: ApplySettingsArgs): Promise<
  ApplySettingsResult | { error: string }
> {
  const { ownerSlug, docoSlug, oldDir, patch } = args;

  let finalSlug = docoSlug;
  let finalDir = oldDir;
  if (patch.slug !== undefined && patch.slug !== docoSlug) {
    const slugError = validateDocoSlug(patch.slug);
    if (slugError) return { error: slugError };
    try {
      const { newDir } = await renameDocoSlug({
        root: rootDir(),
        ownerSlug,
        oldSlug: docoSlug,
        newSlug: patch.slug,
      });
      finalSlug = patch.slug;
      finalDir = newDir;
    } catch (e) {
      return { error: (e as Error).message };
    }
  }

  try {
    await updateDocoMeta({
      docoDir: finalDir,
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.display_name !== undefined ? { display_name: patch.display_name } : {}),
      ...(patch.visibility !== undefined ? { visibility: patch.visibility } : {}),
    });
  } catch (e) {
    return { error: (e as Error).message };
  }
  await reindex(finalDir);

  const updated = readDocoMetadata(finalDir);
  return {
    ok: true,
    finalSlug,
    display_name: updated?.displayName ?? "",
    description: updated?.description ?? "",
    visibility: updated?.visibility ?? "private",
    doco_id: updated?.docoId ?? null,
  };
}
