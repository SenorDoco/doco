import { entityUrl } from "@doco/shared";
import { Link } from "react-router";
import {
  auditSummaryFallback,
  capNodeType,
  iconFromAuditOp,
  lifecycleTransitionText,
  shouldStrikeActivityTarget,
  verbFromAuditOp,
} from "~/lib/activity-feed";
import { cn } from "~/lib/cn";

export interface ActivityFeedLineItem {
  id: string;
  node_type: string;
  summary: string | null;
  at: string;
  op: string;
  lifecycle?: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/**
 * Shared latest-activity row. Mirrors the agent footer-line shape:
 *   ✍️ <Type> added: <summary>          Ns ago
 */
export function ActivityFeedLine({
  item,
  ownerSlug,
  docoSlug,
}: {
  item: ActivityFeedLineItem;
  ownerSlug: string;
  docoSlug: string;
}) {
  const url = entityUrl({
    ownerSlug,
    docoSlug,
    nodeType: item.node_type,
    id: item.id,
  });
  const summary = item.summary ?? auditSummaryFallback(item.node_type, item.id);
  const Type = capNodeType(item.node_type);
  const detail = lifecycleTransitionText(item);
  const strikeTarget = shouldStrikeActivityTarget(item);
  return (
    <div className="flex items-baseline gap-3 px-5 py-3 font-mono text-xs leading-relaxed text-foreground">
      <div className="min-w-0 flex-1">
        <span>{iconFromAuditOp(item.op)} </span>
        <span className="font-semibold">
          {Type} {verbFromAuditOp(item.op)}
        </span>
        <span className="text-muted-foreground">: </span>
        <Link
          to={url}
          className={cn(
            "text-primary hover:underline",
            strikeTarget && "line-through decoration-2",
          )}
        >
          {summary}
        </Link>
        {detail ? <span className="text-muted-foreground">{detail}</span> : null}
      </div>
      <time
        dateTime={item.at}
        title={item.at}
        suppressHydrationWarning
        className="shrink-0 whitespace-nowrap text-[11px] tabular-nums text-muted-foreground"
      >
        {relativeTimeIso(item.at)}
      </time>
    </div>
  );
}

function relativeTimeIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return relativeTimeMs(t);
}

function relativeTimeMs(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${Math.max(s, 0)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
