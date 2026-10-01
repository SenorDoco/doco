// /<doco>/pages/<page-id> — a Notion Doco's home or one of its pages; ?q=
// searches every page instead. The frame around it is $docoHandle.reader.tsx.
import { withClient } from "@doco/db";
import { useLoaderData, useOutletContext } from "react-router";
import { PagesReaderView } from "~/components/reader/pages-views";
import type { ReaderShell } from "~/components/reader/reader-layout";
import { type DocoRouteParams, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { embedQuery } from "~/lib/embedding-provider.server";
import { loadPagesView } from "~/lib/notion-mirror-read.server";
import { readerFor } from "~/lib/reader";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams & { "*"?: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  if (readerFor(ctx.meta.template) !== "pages") throw new Response("Not found", { status: 404 });
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  // Searching pages is hybrid: the query's embedding ranks alongside its words.
  const semantic = query ? (await embedQuery(query)).semantic : null;
  const view = await withClient((c) =>
    loadPagesView(c, ctx.meta.docoId, { pageId: params["*"] ?? "", query, semantic }),
  );
  if (!view) throw new Response("Not found", { status: 404 });
  return { handle: ctx.handle, view };
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Doco" }];
  const { handle, view } = data;
  const what =
    view.view === "page"
      ? view.page.title || "Untitled"
      : view.view === "search"
        ? `“${view.query}”`
        : null;
  return [{ title: [what, handle, "Doco"].filter(Boolean).join(" · ") }];
}

export default function PagesReader() {
  const { handle, view } = useLoaderData<typeof loader>();
  const shell = useOutletContext<ReaderShell>();
  return <PagesReaderView handle={handle} view={view} status={shell.status} />;
}
