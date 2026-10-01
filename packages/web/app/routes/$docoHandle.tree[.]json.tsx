// /<doco>/tree.json — the reader's tree, one listing at a time: what is
// directly under ?under=<id> ("" for the top), or the items ?find=<words>
// names, for Go to file / Go to page. Only codebase and Notion Docos have one.
import { withClient } from "@doco/db";
import { findCodeFiles, listCodeTree } from "~/lib/codebase-read.server";
import { type DocoRouteParams, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { findPages, listPageTree } from "~/lib/notion-mirror-read.server";
import { type ReaderListing, readerFor } from "~/lib/reader";

const FIND_LIMIT = 50;

export async function loader({ request, params }: { request: Request; params: DocoRouteParams }) {
  const ctx = await loadDocoRouteForRead(request, params);
  const reader = readerFor(ctx.meta.template);
  if (!reader) throw new Response("Not found", { status: 404 });
  const url = new URL(request.url);
  const find = url.searchParams.get("find");
  const docoId = ctx.meta.docoId;
  const listing = await withClient(async (c): Promise<ReaderListing> => {
    if (find !== null) {
      const items =
        reader === "code"
          ? await findCodeFiles(c, docoId, find.trim(), FIND_LIMIT)
          : await findPages(c, docoId, find.trim(), FIND_LIMIT);
      return { items, more: 0 };
    }
    const under = url.searchParams.get("under") ?? "";
    return reader === "code" ? listCodeTree(c, docoId, under) : listPageTree(c, docoId, under);
  });
  return Response.json(listing);
}
