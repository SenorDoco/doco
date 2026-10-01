// /<doco>/tree.json — the items ?find=<words> names, for the list under the
// reader's search box, or a codebase's tree one listing at a time: what is
// directly under ?under=<id> ("" for the top). A Notion copy has no tree.
import { withClient } from "@doco/db";
import { findCodeFiles, listCodeTree } from "~/lib/codebase-read.server";
import { type DocoRouteParams, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { findPages } from "~/lib/notion-mirror-read.server";
import { type ReaderListing, readerFor } from "~/lib/reader";

const FIND_LIMIT = 50;

export async function loader({ request, params }: { request: Request; params: DocoRouteParams }) {
  const ctx = await loadDocoRouteForRead(request, params);
  const reader = readerFor(ctx.meta.template);
  const url = new URL(request.url);
  const find = url.searchParams.get("find");
  if (!reader || (reader === "pages" && find === null)) {
    throw new Response("Not found", { status: 404 });
  }
  const docoId = ctx.meta.docoId;
  const listing = await withClient(async (c): Promise<ReaderListing> => {
    if (find !== null) {
      const items =
        reader === "code"
          ? await findCodeFiles(c, docoId, find.trim(), FIND_LIMIT)
          : await findPages(c, docoId, find.trim(), FIND_LIMIT);
      return { items, more: 0 };
    }
    return listCodeTree(c, docoId, url.searchParams.get("under") ?? "");
  });
  return Response.json(listing);
}
