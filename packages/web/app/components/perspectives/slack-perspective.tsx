// Slack perspective — a Slack-mirror Doco's read-only copy of its Slack
// workspace's public channels: a channel list, the selected channel's messages
// newest first with their threads, paging to older messages, and full-text
// search across every channel.
//
// Data: slack-mirror-read.server.ts (loadSlackPerspective). URL state keeps it
// linkable: ?slack_channel=C…, ?slack_before=<ts> (older page), ?slack_q=<search>.
//
// All chrome (border, background, fullscreen) is owned by the PerspectiveFrame;
// this component only paints the content.

import { ExternalLink, Hash, MessageSquare, Paperclip, Search } from "lucide-react";
import { Form, Link } from "react-router";
import { cn } from "~/lib/cn";
import type { SlackPerspectiveData, SlackReaderMessage } from "~/lib/slack-mirror-read.server";
import { timeAgo } from "~/lib/time-ago";

function perspectiveHref(params: Record<string, string>): string {
  return `?${new URLSearchParams({ perspective: "slack", ...params }).toString()}`;
}

export function SlackPerspective({ data, handle }: { data: SlackPerspectiveData; handle: string }) {
  if (!data.teamDomain) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        <p>
          This Doco doesn&apos;t mirror a Slack workspace yet.{" "}
          <Link to={`/${handle}/integrations/slack`} className="font-semibold text-primary">
            Set up the Slack mirror
          </Link>
        </p>
      </div>
    );
  }
  const searching = data.query !== "";
  return (
    <div className="flex h-full min-h-0 gap-3 px-3 pb-3 pt-12">
      <nav aria-label="Slack channels" className="w-44 shrink-0 overflow-y-auto">
        <ul className="space-y-0.5 text-sm">
          {data.channels.map((channel) => (
            <li key={channel.channelId}>
              <Link
                to={perspectiveHref({ slack_channel: channel.channelId })}
                className={cn(
                  "flex items-center gap-1 rounded px-2 py-1 hover:bg-input",
                  !searching && channel.channelId === data.channelId
                    ? "bg-input font-semibold text-foreground"
                    : "text-muted-foreground",
                )}
              >
                <Hash aria-hidden className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{channel.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <section className="flex min-h-0 flex-1 flex-col gap-2">
        <Form method="get" className="flex items-center gap-2">
          <input type="hidden" name="perspective" value="slack" />
          <input
            name="slack_q"
            defaultValue={data.query}
            placeholder="Search every channel"
            aria-label="Search Slack messages"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-sm"
          />
          <button
            type="submit"
            aria-label="Search"
            className="neu-button rounded-md border border-border p-1.5 text-muted-foreground hover:text-foreground"
          >
            <Search aria-hidden className="h-4 w-4" />
          </button>
        </Form>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {data.messages.length === 0 ? (
            <p className="px-2 py-3 text-xs italic text-muted-foreground">
              {searching
                ? "No Slack messages match."
                : "No messages copied yet — new ones appear as they are posted, and history fills in over time."}
            </p>
          ) : (
            <ul className="divide-y divide-border rounded-md border border-border">
              {data.messages.map((message) => (
                <li key={`${message.channelId}:${message.ts}`} className="p-3">
                  <MessageBody message={message} showChannel={searching} />
                  {message.replyCount > 0 ? <Thread message={message} /> : null}
                </li>
              ))}
            </ul>
          )}
          {data.olderBefore && data.channelId ? (
            <Link
              to={perspectiveHref({
                slack_channel: data.channelId,
                slack_before: data.olderBefore,
              })}
              className="mt-2 inline-block text-xs font-semibold text-primary"
            >
              Older messages
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function Thread({ message }: { message: SlackReaderMessage }) {
  const hidden = message.replyCount - message.replies.length;
  return (
    <details className="mt-2 border-l-2 border-border pl-3">
      <summary className="inline-flex cursor-pointer items-center gap-1 text-xs font-semibold text-primary">
        <MessageSquare aria-hidden className="h-3.5 w-3.5" />
        {message.replyCount} {message.replyCount === 1 ? "reply" : "replies"}
      </summary>
      <ul className="mt-2 space-y-3">
        {message.replies.map((reply) => (
          <li key={reply.ts}>
            <MessageBody message={reply} showChannel={false} />
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <a
          href={message.permalink}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-block text-xs text-muted-foreground underline"
        >
          {hidden} more in Slack
        </a>
      ) : null}
    </details>
  );
}

function MessageBody({
  message,
  showChannel,
}: {
  message: SlackReaderMessage;
  showChannel: boolean;
}) {
  return (
    <div className="flex gap-2">
      {message.avatarUrl ? (
        <img src={message.avatarUrl} alt="" className="h-7 w-7 shrink-0 rounded" />
      ) : (
        <span
          aria-hidden
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-input text-xs font-semibold"
        >
          {message.author.slice(0, 1).toUpperCase()}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
          <span className="font-semibold text-foreground">{message.author}</span>
          {showChannel ? (
            <span className="text-muted-foreground">#{message.channelName}</span>
          ) : null}
          <time dateTime={message.postedAt} className="text-muted-foreground">
            {timeAgo(message.postedAt)}
          </time>
          <a
            href={message.permalink}
            target="_blank"
            rel="noreferrer"
            aria-label="Open in Slack"
            className="text-muted-foreground hover:text-foreground"
          >
            <ExternalLink aria-hidden className="h-3 w-3" />
          </a>
        </p>
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">{message.text}</p>
        {message.files.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {message.files.map((file) => (
              <li key={`${file.name}:${file.permalink}`} className="text-xs">
                <Paperclip aria-hidden className="mr-1 inline h-3 w-3" />
                {file.permalink ? (
                  <a href={file.permalink} target="_blank" rel="noreferrer" className="underline">
                    {file.name}
                  </a>
                ) : (
                  file.name
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
