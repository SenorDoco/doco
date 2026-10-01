// The reader's frame, around /<doco>/code/* (a codebase Doco) and
// /<doco>/pages/* (a Notion Doco): the Doco's name and status, one search
// box, for a codebase the tree of what it copied (a Notion copy has none:
// Notion's API shares no teamspaces or sidebar to lay it out as Notion does),
// and the Doco's activity. The child route loads the folder, file, page or
// search in the middle; moving between them reloads only that, never the
// frame or the tree, which fetches the listings it opens itself.
import { withClient } from "@doco/db";
import { useEffect, useRef } from "react";
import {
  Outlet,
  type ShouldRevalidateFunctionArgs,
  useLoaderData,
  useMatches,
  useRevalidator,
  useSearchParams,
} from "react-router";
import { ReaderLayout, type ReaderShell } from "~/components/reader/reader-layout";
import { SiteHeader } from "~/components/site-header";
import { codeTreeAt } from "~/lib/codebase-read.server";
import { type DocoRouteParams, canAdminDoco, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadDocoActivity } from "~/lib/doco-activity.server";
import { loadIntegrationStatuses } from "~/lib/integration-status.server";
import { readerFor } from "~/lib/reader";

/** How often the reader refreshes while its copy is still coming in. */
const IMPORT_POLL_MS = 5000;

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: DocoRouteParams & { "*"?: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const reader = readerFor(ctx.meta.template);
  if (!reader || new URL(request.url).pathname.split("/")[2] !== reader) {
    throw new Response("Not found", { status: 404 });
  }
  const at = params["*"] ?? "";
  const docoId = ctx.meta.docoId;
  return withClient(async (c) => {
    const source = reader === "code" ? "github" : "notion";
    const status = (await loadIntegrationStatuses(c, docoId)).find(
      (s) => s.integration === source,
    ) ?? { integration: source, state: "unconnected" as const };
    const shell: ReaderShell = {
      handle: ctx.handle,
      reader,
      template: ctx.meta.template ?? "",
      ownerSlug: ctx.canonicalOwnerSlug,
      ownerIsWorkspace: ctx.meta.ownerId.startsWith("workspace_"),
      visibility: ctx.meta.visibility,
      goal: ctx.meta.goal,
      canAdmin: await canAdminDoco(ctx.meta, ctx.me?.id ?? null),
      status,
      tree: reader === "code" ? await codeTreeAt(c, docoId, at) : null,
      activity: await loadDocoActivity(c, docoId),
    };
    return { me: ctx.me, shell };
  });
}

// The frame loads once per Doco: following a link or searching reloads only
// the child. A refresh asked for in place (the import poll) reloads it too.
export function shouldRevalidate({
  currentUrl,
  nextUrl,
  currentParams,
  nextParams,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  if (currentParams.docoHandle !== nextParams.docoHandle) return defaultShouldRevalidate;
  return currentUrl.href === nextUrl.href ? defaultShouldRevalidate : false;
}

export default function DocoReader() {
  const { me, shell } = useLoaderData<typeof loader>();
  const [searchParams] = useSearchParams();
  // The open item's place in the tree comes with what the child loaded.
  const view = (useMatches().at(-1)?.data as { view?: { trail: string[] } } | undefined)?.view;

  // While the copy is still coming in, keep what the reader shows current.
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;
  const importing = shell.status.state === "importing";
  useEffect(() => {
    if (!importing) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible" && revalidatorRef.current.state === "idle") {
        revalidatorRef.current.revalidate();
      }
    }, IMPORT_POLL_MS);
    return () => clearInterval(id);
  }, [importing]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SiteHeader me={me} />
      <ReaderLayout
        shell={shell}
        trail={view?.trail ?? []}
        query={(searchParams.get("q") ?? "").trim()}
      >
        <Outlet context={shell} />
      </ReaderLayout>
    </div>
  );
}
