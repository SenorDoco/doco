// /<doco>/code/<owner>/<repo>/<path> — a codebase Doco's repositories, a
// folder, or a file, addressed as on GitHub; ?q= searches the code instead.
// The frame around it is $docoHandle.reader.tsx.
import { withClient } from "@doco/db";
import { useLoaderData, useOutletContext } from "react-router";
import { CodeReaderView } from "~/components/reader/code-views";
import type { ReaderShell } from "~/components/reader/reader-layout";
import { ReaderHome } from "~/components/reader/reader-parts";
import { loadCodeView } from "~/lib/codebase-read.server";
import { type DocoRouteParams, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadDocoActivity } from "~/lib/doco-activity.server";
import { readerFor } from "~/lib/reader";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams & { "*"?: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  if (readerFor(ctx.meta.template) !== "code") throw new Response("Not found", { status: 404 });
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const id = params["*"] ?? "";
  // The home, like every Doco's home, shows the Doco's activity beside it.
  const atHome = id === "" && !query;
  const [view, activity] = await withClient((c) =>
    Promise.all([
      loadCodeView(c, ctx.meta.docoId, { id, query }),
      atHome ? loadDocoActivity(c, ctx.meta.docoId) : null,
    ]),
  );
  if (!view) throw new Response("Not found", { status: 404 });
  return { handle: ctx.handle, view, activity };
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Doco" }];
  const { handle, view } = data;
  const what =
    view.view === "file"
      ? view.file.path.split("/").pop()
      : view.view === "folder"
        ? [view.repo, view.dir].filter(Boolean).join("/")
        : view.view === "search"
          ? `“${view.query}”`
          : null;
  return [{ title: [what, handle, "Doco"].filter(Boolean).join(" · ") }];
}

export default function CodeReader() {
  const { handle, view, activity } = useLoaderData<typeof loader>();
  const shell = useOutletContext<ReaderShell>();
  const reader = <CodeReaderView handle={handle} view={view} status={shell.status} />;
  return activity ? (
    <ReaderHome handle={handle} activity={activity}>
      {reader}
    </ReaderHome>
  ) : (
    reader
  );
}
