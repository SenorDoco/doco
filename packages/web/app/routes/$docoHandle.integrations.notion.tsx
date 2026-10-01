// /<doco-handle>/integrations/notion — turn this Doco into a read-only copy of
// the Notion pages and databases a workspace shares with Doco, and manage it.
//
// Turning it on: an owner of the Doco's workspace confirms what will be stored
// (on behalf of their organization), then picks the pages to share on Notion's
// authorization page. The OAuth callback records the mirror
// (lib/notion-mirror-setup.server.ts); the sync copies the pages
// (lib/notion-mirror-sync.server.ts) and the webhook keeps them current
// (lib/notion-mirror.server.ts).
import { getWorkspaceRole } from "@doco/db";
import { FileText } from "lucide-react";
import { Form, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import { getNotionConfig } from "~/lib/notion-api.server";
import {
  buildNotionAuthorizeUrl,
  loadNotionMirrorStatus,
  requestNotionResync,
  stopNotionMirror,
} from "~/lib/notion-mirror-setup.server";
import { timeAgo } from "~/lib/time-ago";

type RouteArgs = { request: Request; params: { docoHandle: string } };

export async function loader({ request, params }: RouteArgs) {
  const { me, meta, ownerSlug } = await loadDocoRouteForRead(request, params);
  const canManage = me ? (await getWorkspaceRole(meta.workspaceId, me.id)) === "owner" : false;
  return {
    handle: meta.handle,
    ownerSlug,
    visibility: meta.visibility,
    canManage,
    notionConfigured: getNotionConfig().configured,
    status: await loadNotionMirrorStatus(meta.docoId),
  };
}

type ActionResult = { error: string } | { ok: true; message: string };

export async function action({ request, params }: RouteArgs): Promise<ActionResult> {
  const { me, meta } = await loadDocoRouteForRead(request, params);
  if (!me || (await getWorkspaceRole(meta.workspaceId, me.id)) !== "owner") {
    return { error: "Only an owner of this Doco's workspace can manage its Notion mirror." };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "start" || intent === "reconnect") {
    if (intent === "start" && form.get("consent") !== "on") {
      return { error: "Confirm that Doco may store and sync a copy of the pages you share." };
    }
    if (meta.visibility !== "private") {
      return { error: "Make this Doco private first: a Notion mirror is never public." };
    }
    const url = buildNotionAuthorizeUrl(request, {
      docoId: meta.docoId,
      workspaceId: meta.workspaceId,
      userId: me.id,
    });
    if (!url) return { error: "Notion isn't configured on this host." };
    throw redirect(url);
  }
  if (intent === "resync") {
    await requestNotionResync(meta.docoId);
    return { ok: true, message: "Re-sync requested. The next sync walks every shared page again." };
  }
  if (intent === "stop") {
    await stopNotionMirror(meta.docoId);
    return { ok: true, message: "Mirroring stopped. The copy was deleted." };
  }
  return { error: `Unknown action: ${intent}` };
}

export function meta({ params }: { params: { docoHandle: string } }) {
  return [{ title: `Notion · App integrations · ${params.docoHandle} · Doco` }];
}

const PRIMARY_BTN =
  "neu-button inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-55";
const NEUTRAL_BTN =
  "neu-button rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-input hover:text-foreground";
const NOTICE = "rounded-md border border-border bg-background p-3 text-sm text-foreground";
const ERROR_NOTICE =
  "rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive";

/** What the callback's `?notion=` flash means to the reader. */
const FLASH: Record<string, { text: string; error: boolean }> = {
  mirroring: {
    text: "Mirroring is on. Doco discovers the pages you shared within a minute; content fills in at about a hundred pages a minute, and later edits arrive within seconds.",
    error: false,
  },
  denied: { text: "Notion's authorization was cancelled. Nothing was connected.", error: true },
  signin_required: { text: "Sign in, then approve in Notion again.", error: true },
  forbidden: {
    text: "The Notion approval must come from the same signed-in user who started it.",
    error: true,
  },
  not_owner: {
    text: "Only an owner of this Doco's workspace can turn mirroring on.",
    error: true,
  },
  authorization_failed: {
    text: "Notion did not complete the authorization. Try again.",
    error: true,
  },
  workspace_mirrored_elsewhere: {
    text: "That Notion workspace is already mirrored into another doco. Stop that mirror first, or pick a different workspace.",
    error: true,
  },
};

export default function DocoNotionMirrorPage() {
  const { handle, ownerSlug, visibility, canManage, notionConfigured, status } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const flash = FLASH[searchParams.get("notion") ?? ""];
  const otherHandle = searchParams.get("handle");

  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-6">
      <PageHeader
        breadcrumb={docoBreadcrumb({
          ownerSlug,
          handle,
          parent: { label: "App integrations", to: `/${handle}/integrations` },
          pageLabel: "Notion",
        })}
        title="Notion"
      >
        <p className="text-sm text-muted-foreground">
          A read-only copy of the Notion pages and databases a workspace shares with Doco, kept in
          sync.
        </p>
      </PageHeader>

      {flash ? (
        <p className={flash.error ? ERROR_NOTICE : NOTICE}>
          {flash.text}
          {otherHandle && searchParams.get("notion") === "workspace_mirrored_elsewhere" ? (
            <>
              {" "}
              (<span className="font-mono">{otherHandle}</span>)
            </>
          ) : null}
        </p>
      ) : null}
      {actionData && "error" in actionData ? (
        <p className={ERROR_NOTICE}>{actionData.error}</p>
      ) : null}
      {actionData && "ok" in actionData ? <p className={NOTICE}>{actionData.message}</p> : null}

      {status ? (
        <MirrorStatus status={status} canManage={canManage} />
      ) : (
        <TurnOnMirror
          canManage={canManage}
          notionConfigured={notionConfigured}
          isPrivate={visibility === "private"}
        />
      )}
    </main>
  );
}

function TurnOnMirror({
  canManage,
  notionConfigured,
  isPrivate,
}: {
  canManage: boolean;
  notionConfigured: boolean;
  isPrivate: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mirror a Notion workspace</CardTitle>
        <CardDescription>
          Every page and database you share with Doco in Notion&apos;s page picker is copied here
          and kept in sync, including pages added under them later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Only what you share: Notion&apos;s page picker decides. Pages you don&apos;t share are
            never seen.
          </li>
          <li>Files and images are kept as links; their contents are never copied.</li>
          <li>
            Deleting, trashing or unsharing a page in Notion deletes its copy here. Stopping the
            mirror deletes the whole copy.
          </li>
          <li>
            Page text is processed by Doco&apos;s AI providers (OpenAI for search, Anthropic for
            Señor Doco) under API terms that exclude training on it.
          </li>
          <li>
            This Doco stays private. An owner of this Doco&apos;s workspace confirms on behalf of
            the organization; in Notion, a workspace admin may need to allow the Doco integration.
          </li>
        </ul>
        {!canManage ? (
          <p className="text-muted-foreground">
            An owner of this Doco&apos;s workspace can turn mirroring on.
          </p>
        ) : !notionConfigured ? (
          <p className="text-muted-foreground">Notion isn&apos;t configured on this host.</p>
        ) : !isPrivate ? (
          <p className="text-muted-foreground">Make this Doco private first.</p>
        ) : (
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="start" />
            <label className="flex items-start gap-2">
              <input type="checkbox" name="consent" required className="mt-1" />
              <span>
                On behalf of your organization, you authorize Doco to store and sync a copy of the
                Notion pages you share, as described above.
              </span>
            </label>
            <button type="submit" className={PRIMARY_BTN}>
              Continue to Notion
            </button>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}

function MirrorStatus({
  status,
  canManage,
}: {
  status: NonNullable<Awaited<ReturnType<typeof loader>>["status"]>;
  canManage: boolean;
}) {
  const progress = status.discoveredAt
    ? status.pending > 0
      ? `${status.synced.toLocaleString("en-US")} of ${status.pages.toLocaleString("en-US")} pages copied`
      : `${status.pages.toLocaleString("en-US")} pages copied`
    : status.pages > 0
      ? `discovering pages · ${status.synced.toLocaleString("en-US")} of ${status.pages.toLocaleString("en-US")} copied so far`
      : "discovering the pages shared with Doco";
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Mirroring{" "}
            {status.workspaceIcon?.length === 1 || status.workspaceIcon?.length === 2
              ? `${status.workspaceIcon} `
              : ""}
            {status.workspaceName || "a Notion workspace"}
          </CardTitle>
          <CardDescription>
            {progress}
            {status.tickedAt ? ` · last sync ${timeAgo(status.tickedAt)}` : " · first sync pending"}
            {status.authorizedBy ? ` · authorized in Notion by ${status.authorizedBy}` : ""}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {status.needsReauth ? (
            <p className={ERROR_NOTICE}>
              Notion no longer accepts this connection (the integration was removed, or the token
              expired). Reconnect to resume syncing; the copy is kept meanwhile.
            </p>
          ) : null}
          {status.parked.length > 0 ? (
            <div>
              <p className="font-semibold text-foreground">
                {status.parked.length} {status.parked.length === 1 ? "page" : "pages"} the sync
                could not copy
              </p>
              <ul className="mt-1 divide-y divide-border text-xs">
                {status.parked.map((page) => (
                  <li key={page.pageId} className="flex items-center gap-2 py-1.5">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <a href={page.url} target="_blank" rel="noreferrer" className="underline">
                      {page.title || page.pageId}
                    </a>
                    <span className="truncate text-muted-foreground">{page.error}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {canManage ? (
            <div className="flex flex-wrap gap-2">
              {status.needsReauth ? (
                <Form method="post">
                  <button type="submit" name="intent" value="reconnect" className={PRIMARY_BTN}>
                    Reconnect Notion
                  </button>
                </Form>
              ) : null}
              <Form method="post">
                <button type="submit" name="intent" value="resync" className={NEUTRAL_BTN}>
                  Re-sync every page
                </button>
              </Form>
            </div>
          ) : null}
        </CardContent>
      </Card>
      {canManage ? (
        <Form
          method="post"
          onSubmit={(event) => {
            if (!window.confirm("Stop mirroring? The whole copy is deleted.")) {
              event.preventDefault();
            }
          }}
        >
          <button type="submit" name="intent" value="stop" className={NEUTRAL_BTN}>
            Stop mirroring and delete the copy
          </button>
        </Form>
      ) : null}
    </>
  );
}
