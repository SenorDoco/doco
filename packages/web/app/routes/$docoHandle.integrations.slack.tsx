// /<doco-handle>/integrations/slack — turn this Doco into a read-only copy of a
// Slack workspace's public channels, and manage it.
//
// Turning it on: an owner of the Doco's workspace confirms what will be stored
// (Slack's API terms require the organization's explicit authorization), then
// approves in Slack. The OAuth callback checks that the approving Slack user is
// a Slack admin or owner, records the mirror, and starts the first sync
// (lib/slack-mirror-setup.server.ts). The live copy is kept by the Slack
// events route (lib/slack-mirror.server.ts).
import { getWorkspaceRole } from "@doco/db";
import { Hash } from "lucide-react";
import { Form, redirect, useActionData, useLoaderData, useSearchParams } from "react-router";
import { docoBreadcrumb } from "~/components/breadcrumb";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { PageHeader } from "~/components/page-header";
import { SiteHeader } from "~/components/site-header";
import { loadDocoRouteForRead } from "~/lib/doco-access.server";
import {
  MIRROR_HISTORY_YEARS,
  loadSlackMirrorStatus,
  setSlackMirrorChannelExcluded,
  stopSlackMirror,
} from "~/lib/slack-mirror-setup.server";
import { buildSlackInstallUrl, getSlackConfig } from "~/lib/slack.server";

type RouteArgs = { request: Request; params: { docoHandle: string } };

export async function loader({ request, params }: RouteArgs) {
  const { me, meta, ownerSlug } = await loadDocoRouteForRead(request, params);
  const canManage = me ? (await getWorkspaceRole(meta.workspaceId, me.id)) === "owner" : false;
  return {
    me,
    handle: meta.handle,
    ownerSlug,
    visibility: meta.visibility,
    canManage,
    slackConfigured: getSlackConfig().configured,
    historyYears: MIRROR_HISTORY_YEARS,
    status: await loadSlackMirrorStatus(meta.docoId),
  };
}

type ActionResult = { error: string } | { ok: true; message: string };

export async function action({ request, params }: RouteArgs): Promise<ActionResult> {
  const { me, meta } = await loadDocoRouteForRead(request, params);
  if (!me || (await getWorkspaceRole(meta.workspaceId, me.id)) !== "owner") {
    return { error: "Only an owner of this Doco's workspace can manage its Slack mirror." };
  }
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const channelId = String(form.get("channel_id") ?? "");

  if (intent === "start") {
    if (form.get("consent") !== "on") {
      return { error: "Confirm that Doco may store and sync a copy of the public channels." };
    }
    if (meta.visibility !== "private") {
      return { error: "Make this Doco private first: a Slack mirror is never public." };
    }
    const url = buildSlackInstallUrl(request, me.id, meta.workspaceId, {
      mirrorDocoId: meta.docoId,
    });
    if (!url) return { error: "Slack isn't configured on this host." };
    throw redirect(url);
  }
  if ((intent === "exclude" || intent === "include") && channelId) {
    await setSlackMirrorChannelExcluded({
      docoId: meta.docoId,
      channelId,
      excluded: intent === "exclude",
    });
    return {
      ok: true,
      message:
        intent === "exclude"
          ? "Channel excluded. Everything copied from it was deleted."
          : "Channel included. It will be joined and copied on the next sync.",
    };
  }
  if (intent === "stop") {
    await stopSlackMirror(meta.docoId);
    return { ok: true, message: "Mirroring stopped. The copy was deleted." };
  }
  return { error: `Unknown action: ${intent}` };
}

export function meta({ params }: { params: { docoHandle: string } }) {
  return [{ title: `Slack · App integrations · ${params.docoHandle} · Doco` }];
}

const PRIMARY_BTN =
  "neu-button inline-flex items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90 disabled:opacity-55";
const NEUTRAL_BTN =
  "neu-button rounded-md border border-border px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-input hover:text-foreground";
const NOTICE = "rounded-md border border-border bg-background p-3 text-sm text-foreground";
const ERROR_NOTICE =
  "rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive";

export default function DocoSlackMirrorPage() {
  const { me, handle, ownerSlug, visibility, canManage, slackConfigured, historyYears, status } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [searchParams] = useSearchParams();
  const flash = searchParams.get("slack");

  return (
    <div>
      <SiteHeader me={me} />
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-6">
        <PageHeader
          breadcrumb={docoBreadcrumb({
            ownerSlug,
            handle,
            parent: { label: "App integrations", to: `/${handle}/integrations` },
            pageLabel: "Slack",
          })}
          title="Slack"
        >
          <p className="text-sm text-muted-foreground">
            A read-only copy of a Slack workspace&apos;s public channels, kept in sync.
          </p>
        </PageHeader>

        {flash === "mirroring" ? (
          <p className={NOTICE}>
            Mirroring is on. Doco is joining the public channels now; new messages are copied as
            they are posted, and older history fills in, newest first.
          </p>
        ) : null}
        {flash === "not_slack_admin" ? (
          <p className={ERROR_NOTICE}>
            Only a Slack workspace admin or owner can approve copying its channels. Ask one to turn
            mirroring on from this page.
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
            historyYears={historyYears}
            canManage={canManage}
            slackConfigured={slackConfigured}
            isPrivate={visibility === "private"}
          />
        )}
      </main>
    </div>
  );
}

function TurnOnMirror({
  historyYears,
  canManage,
  slackConfigured,
  isPrivate,
}: {
  historyYears: number;
  canManage: boolean;
  slackConfigured: boolean;
  isPrivate: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Mirror a Slack workspace</CardTitle>
        <CardDescription>
          Every public channel is copied here and kept in sync — including channels created later.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            Public channels only: never DMs, private channels, or channels shared with another
            organization.
          </li>
          <li>History going back {historyYears} years fills in gradually, newest first.</li>
          <li>Files are kept as links; their contents are never copied.</li>
          <li>
            Deleting a message in Slack deletes it here. Stopping the mirror or uninstalling the
            Slack app deletes the whole copy.
          </li>
          <li>
            Message text is processed by Doco&apos;s AI providers (OpenAI for search, Anthropic for
            Señor Doco) under API terms that exclude training on it.
          </li>
          <li>This Doco stays private. Only a Slack workspace admin or owner can approve.</li>
        </ul>
        {!canManage ? (
          <p className="text-muted-foreground">
            An owner of this Doco&apos;s workspace can turn mirroring on.
          </p>
        ) : !slackConfigured ? (
          <p className="text-muted-foreground">Slack isn&apos;t configured on this host.</p>
        ) : !isPrivate ? (
          <p className="text-muted-foreground">Make this Doco private first.</p>
        ) : (
          <Form method="post" className="space-y-3">
            <input type="hidden" name="intent" value="start" />
            <label className="flex items-start gap-2">
              <input type="checkbox" name="consent" required className="mt-1" />
              <span>
                On behalf of your organization, you authorize Doco to store and sync a copy of this
                Slack workspace&apos;s public channels as described above.
              </span>
            </label>
            <button type="submit" className={PRIMARY_BTN}>
              Continue to Slack
            </button>
          </Form>
        )}
      </CardContent>
    </Card>
  );
}

function historyProgress(channel: {
  historyDone: boolean;
  historyBackTo: string | null;
}): string {
  if (channel.historyDone) return "history complete";
  return channel.historyBackTo
    ? `history back to ${channel.historyBackTo.slice(0, 10)}`
    : "history queued";
}

function MirrorStatus({
  status,
  canManage,
}: {
  status: NonNullable<Awaited<ReturnType<typeof loader>>["status"]>;
  canManage: boolean;
}) {
  const mirrored = status.channels.filter((c) => !c.excluded);
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Mirroring {status.teamName || status.teamDomain}
          </CardTitle>
          <CardDescription>
            {mirrored.length} public {mirrored.length === 1 ? "channel" : "channels"} ·{" "}
            {status.messageCount.toLocaleString()} messages copied · copying history back to{" "}
            {status.historySince.slice(0, 10)}
            {status.threadsPending > 0
              ? ` · ${status.threadsPending.toLocaleString()} threads waiting for earlier replies`
              : ""}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border text-sm">
            {status.channels.map((channel) => (
              <li key={channel.channelId} className="flex items-center justify-between gap-3 py-2">
                <span className="flex items-center gap-1.5">
                  <Hash className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <span className={channel.excluded ? "text-muted-foreground line-through" : ""}>
                    {channel.name}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {channel.excluded
                      ? "excluded"
                      : channel.archived
                        ? "archived"
                        : channel.joined
                          ? `${channel.messages.toLocaleString()} messages · ${historyProgress(channel)}`
                          : "joining…"}
                  </span>
                </span>
                {canManage ? (
                  <Form method="post">
                    <input type="hidden" name="channel_id" value={channel.channelId} />
                    <button
                      type="submit"
                      name="intent"
                      value={channel.excluded ? "include" : "exclude"}
                      className={NEUTRAL_BTN}
                    >
                      {channel.excluded ? "Include" : "Exclude"}
                    </button>
                  </Form>
                ) : null}
              </li>
            ))}
          </ul>
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
