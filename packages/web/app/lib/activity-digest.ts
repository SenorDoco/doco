// The activity digest: the email every member of a workspace gets about what
// happened in it, with the totals of queries, writes and imports and who and
// what made the most of each. It goes out at 13:00 UTC every day, covering the
// previous 24 hours, unless the member switched it to weekly: then every
// Monday, covering the previous 7 days. Each one has a button that switches it
// between the two and a link that unsubscribes. Pure: which digests are due,
// and their message (lib/activity-digest.server.ts sends them).

import type { ActivitySummary, TopActor } from "./activity-log.server";
import { viaLabel } from "./authoring-provenance";
import { type EmailBlock, emailHtml } from "./email-html";
import type { Email } from "./email.server";

/** The hour of the day, in UTC, the digests go out. */
export const DIGEST_HOUR_UTC = 13;
/** How many rows each top list shows. */
export const DIGEST_TOP_LIMIT = 5;

/** How often a member gets a workspace's digest (workspace_users.digest):
 *  every day unless they switched it to weekly, never once they unsubscribed. */
export type DigestSetting = "daily" | "weekly" | "off";
export type Cadence = Exclude<DigestSetting, "off">;

const DAY_MS = 86_400_000;

/** The digests that go out at `at`: the daily one, and on Mondays the weekly. */
export function settingsDue(at: Date): Cadence[] {
  return at.getUTCDay() === 1 ? ["daily", "weekly"] : ["daily"];
}

/** The time a digest sent at `at` covers. */
export function digestPeriod(cadence: Cadence, at: Date): { since: string; until: string } {
  const days = cadence === "daily" ? 1 : 7;
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
  setting: Cadence;
  summary: ActivitySummary;
  /** Names the member to /digest/<setting> (lib/activity-digest.server.ts). */
  token: string;
}): Omit<Email, "to"> {
  const { workspaceHandle: ws, setting, summary: s } = opts;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/workspaces/${ws}`;
  const t = new URLSearchParams({ t: opts.token });
  const other = setting === "daily" ? "weekly" : "daily";
  const switchUrl = `${base}/digest/${other}?${t}`;
  const unsubscribeUrl = `${base}/digest/unsubscribe?${t}`;
  const period = setting === "daily" ? "the last 24 hours" : "the last 7 days";
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
  const switchLabel = `Switch to ${other}`;
  const footer = `You get this digest ${setting === "daily" ? "every day" : "every Monday"} as a member of ${ws}.`;

  const text = [
    intro,
    stats.map((st) => `${st.value} ${st.label}`).join(" · "),
    ...lists.map(([title, lines]) =>
      [title, ...(lines.length > 0 ? lines : [none]).map((l) => `- ${l}`)].join("\n"),
    ),
    `Open ${ws}: ${url}`,
    `${switchLabel}: ${switchUrl}`,
    `${footer} Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n\n");

  const blocks: EmailBlock[] = [
    intro,
    { stats },
    ...lists.flatMap(([title, lines]): EmailBlock[] => [
      { heading: title },
      lines.length > 0 ? { list: lines } : none,
    ]),
    { link: url, label: `Open ${ws}` },
    { link: switchUrl, label: switchLabel, quiet: true },
    { footer, link: unsubscribeUrl, label: "Unsubscribe" },
  ];

  return {
    subject: `Your ${setting} digest for ${ws} on Doco`,
    text: `${text}\n`,
    html: emailHtml(blocks),
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
