import { entityUrl } from "@doco/shared";
import { Link } from "react-router";
import {
  activityRowLifecycle,
  auditSummaryFallback,
  capNodeType,
  iconFromAuditOp,
  lifecycleTransitionText,
  shouldStrikeActivityTarget,
  verbFromAuditOp,
} from "~/lib/activity-feed";
import { cn } from "~/lib/cn";
import { lifecycleColor } from "~/lib/node-colors";
import { handleNodeDialogLinkClick } from "~/lib/node-dialog-link";

export interface ActivityFeedLineItem {
  id: string;
  entity_type: string;
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
  docoHandle,
  onOpenNode,
}: {
  item: ActivityFeedLineItem;
  docoHandle: string;
  onOpenNode?: (item: ActivityFeedLineItem, href: string) => void;
}) {
  const url = entityUrl({
    docoHandle,
    nodeType: item.entity_type,
    id: item.id,
  });
  const summary = item.summary ?? auditSummaryFallback(item.entity_type, item.id);
  const Type = capNodeType(item.entity_type);
  const detail = lifecycleTransitionText(item);
  const strikeTarget = shouldStrikeActivityTarget(item);
  return (
    <Link
      to={url}
      onClick={
        onOpenNode
          ? (event) => handleNodeDialogLinkClick(event, () => onOpenNode(item, url))
          : undefined
      }
      className="group flex items-baseline gap-3 px-5 py-3 font-mono text-xs leading-relaxed no-underline hover:bg-muted/35"
    >
      <div className="min-w-0 flex-1">
        <span>{iconFromAuditOp(item.op)} </span>
        <span className="font-semibold">
          {Type} {verbFromAuditOp(item.op)}
        </span>
        <span className="text-muted-foreground">: </span>
        <span
          style={{ color: lifecycleColor(activityRowLifecycle(item)) }}
          className={cn("group-hover:underline", strikeTarget && "line-through decoration-2")}
        >
          {summary}
        </span>
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
    </Link>
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
