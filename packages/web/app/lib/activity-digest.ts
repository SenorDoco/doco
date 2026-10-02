// The activity digest: the email every member of a workspace gets about what
// happened in it, with the totals of queries, writes and imports and who and
// what made the most of each. It goes out at 13:00 UTC: every day during the
// workspace's first week, each covering the previous 24 hours, then once a
// week, each covering the previous 7 days. Pure: which digest is due, and its
// message (lib/activity-digest.server.ts sends it).

import type { ActivitySummary, TopActor } from "./activity-log.server";
import { viaLabel } from "./authoring-provenance";
import { type EmailBlock, emailHtml } from "./email-html";
import type { Email } from "./email.server";

/** The hour of the day, in UTC, the digests go out. */
export const DIGEST_HOUR_UTC = 13;
/** How many rows each top list shows. */
export const DIGEST_TOP_LIMIT = 5;
/** How many daily digests a workspace gets before they turn weekly. */
export const DAILY_DIGESTS = 7;

const DAY_MS = 86_400_000;

export type DigestDue = { kind: "daily"; day: number } | { kind: "weekly" };

/**
 * The digest a workspace created at `createdAt` gets at `at` (a sending
 * time), or null. Counting the sending times since it was created: the first
 * seven are daily (`day` 1 to 7), then every seventh is weekly (the 14th, the
 * 21st, …), so each digest covers the time since the one before it.
 */
export function digestDue(createdAt: Date, at: Date): DigestDue | null {
  const n = Math.ceil((at.getTime() - createdAt.getTime()) / DAY_MS);
  if (n < 1) return null;
  if (n <= DAILY_DIGESTS) return { kind: "daily", day: n };
  return n % DAILY_DIGESTS === 0 ? { kind: "weekly" } : null;
}

/** The time a digest sent at `at` covers. */
export function digestPeriod(due: DigestDue, at: Date): { since: string; until: string } {
  const days = due.kind === "daily" ? 1 : 7;
  return {
    since: new Date(at.getTime() - days * DAY_MS).toISOString(),
    until: at.toISOString(),
  };
}

const count = (n: number) => n.toLocaleString("en-US");
const actorLine = (a: TopActor) => `${a.username} ${viaLabel(a.via)}: ${count(a.count)}`;

export function digestEmail(opts: {
  baseUrl: string;
  workspaceHandle: string;
  due: DigestDue;
  summary: ActivitySummary;
  unsubscribeUrl: string;
}): Omit<Email, "to"> {
  const { workspaceHandle: ws, due, summary: s } = opts;
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/workspaces/${ws}`;
  const period = due.kind === "daily" ? "the last 24 hours" : "the last 7 days";
  const none = `None in ${period}.`;
  const intro = `Here's what happened in ${ws} in ${period}.`;
  const stats = [
    { value: count(s.queries), label: s.queries === 1 ? "query" : "queries" },
    { value: count(s.writes), label: s.writes === 1 ? "write" : "writes" },
    { value: count(s.imports), label: s.imports === 1 ? "import" : "imports" },
  ];
  const lists: [string, string[]][] = [
    ["Top queryers", s.topQueryers.map(actorLine)],
    ["Top contributors", s.topContributors.map(actorLine)],
    ["Top integrations", s.topIntegrations.map((i) => `${i.name}: ${count(i.count)}`)],
  ];
  const schedule =
    due.kind === "daily"
      ? `This digest comes every day during ${ws}'s first week (day ${due.day} of ${DAILY_DIGESTS}). From the second week on, it comes once a week and covers the previous 7 days.`
      : null;
  const footer = `You get this digest as a member of ${ws}.`;

  const text = [
    intro,
    stats.map((st) => `${st.value} ${st.label}`).join(" · "),
    ...lists.map(([title, lines]) =>
      [title, ...(lines.length > 0 ? lines : [none]).map((l) => `- ${l}`)].join("\n"),
    ),
    ...(schedule ? [schedule] : []),
    `Open ${ws}: ${url}`,
    `${footer} Unsubscribe: ${opts.unsubscribeUrl}`,
  ].join("\n\n");

  const blocks: EmailBlock[] = [
    intro,
    { stats },
    ...lists.flatMap(([title, lines]): EmailBlock[] => [
      { heading: title },
      lines.length > 0 ? { list: lines } : none,
    ]),
    ...(schedule ? [schedule] : []),
    { link: url, label: `Open ${ws}` },
    { footer, link: opts.unsubscribeUrl, label: "Unsubscribe" },
  ];

  return {
    subject: `Your ${due.kind} digest for ${ws} on Doco`,
    text: `${text}\n`,
    html: emailHtml(blocks),
    headers: {
      "List-Unsubscribe": `<${opts.unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
