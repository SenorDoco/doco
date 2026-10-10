// The activity digest: each workspace's newspaper, The <Workspace> Times, the
// email every member of a workspace gets about what happened in it. It is
// laid out as a front page under a masthead of its title in Chomsky, the
// blackletter Doco's logo is set in (lib/masthead.server.ts draws it). It
// leads with the most important records added in it
// (lib/front-page.server.ts ranks them): a lead story, two more beside
// it and the rest in brief; then the totals of queries, writes and imports and
// who and what made the most of each. When nothing at all happened, it comes
// out anyway and leads with one of SLOW_NEWS's headlines instead. The daily
// edition goes out at midnight Pacific Time, covering the day before, unless
// the member switched it to weekly: then every Monday, covering the week
// before. Each one has a button
// that switches it between the two and a link that unsubscribes. Pure: which
// editions are due, and their message (lib/activity-digest.server.ts sends
// them).

import type { ActivitySummary, TopActor } from "./activity-log.server";
import { viaLabel } from "./authoring-provenance";
import { type EmailBlock, emailHtml } from "./email-html";
import type { Email } from "./email.server";

/** Whose midnight the editions go out at, daylight saving time included. */
export const DIGEST_TIME_ZONE = "America/Los_Angeles";
/** How many rows each top list shows. */
export const DIGEST_TOP_LIMIT = 5;
/** How many stories a front page carries: the lead, two beside it, the rest in brief. */
export const FRONT_PAGE_STORIES = 8;

/** How often a member gets a workspace's digest (workspace_users.digest):
 *  every day unless they switched it to weekly, never once they unsubscribed. */
export type DigestSetting = "daily" | "weekly" | "off";
export type Cadence = Exclude<DigestSetting, "off">;

/** A story on the front page: a record added in the period, the headline
 *  and the sentence Claude gave it, and where it lives. */
export interface Story {
  id: string;
  docoId: string;
  docoHandle: string;
  nodeType: string;
  headline: string;
  /** What it says, in a sentence; empty when no model wrote one. */
  takeaway: string;
  url: string;
}

/** What a paper leads with when nothing was queried, written or imported in
 *  its period: one a day, each once before any repeats (Alexander,
 *  2026-10-10). */
export const SLOW_NEWS = [
  "Workspace Takes a Breather; Experts Urge Calm",
  "Agents Report for Duty, Find Nothing to Do, Go Home",
  'Silence Falls Over Workspace; Neighbors Call It "Peaceful"',
  "Knowledge Base Remains Exactly as Smart as Before",
  "Zero Decisions Made, in What Analysts Call a Bold Decision",
  "Tumbleweed Spotted Rolling Through the Docos",
  "Breaking: Nothing Breaks",
  "No Questions Asked, None Answered, No Harm Done",
  "Crystal Ball Consulted; It Reports Clear Skies Ahead",
  "Record Set for Fewest Records Set",
  "Editors Scramble to Fill Front Page, Settle on This Headline",
  "Agents Seen Refreshing Their Inboxes, Hoping for a Task",
  "All Quiet on Every Front, Integrations Confirm",
  "Calm Before the Storm, Say Sources Who Could Not Name a Storm",
  "Workspace Hits Inbox Zero, and Output Zero Too",
  "Nobody Wrote Anything Down, and Nobody Forgot Anything Either",
  "Docos Wait Patiently for Someone to Ask Them Something",
  "Rumors of a Big Decision Remain, for Now, Rumors",
  "Forecast: Clear Skies, Light Breeze, Zero Imports",
  "Knowledge Graph Spends Quiet Time Reflecting on Its Edges",
  "Archivists Take Long Lunch as Nothing Needs Filing",
  "Workspace Declares Unofficial Holiday; Nobody Objects, or Says Anything",
  "Señor Doco Rereads the Last Edition, Enjoys It Just as Much",
  "Peace Talks Succeed: Not a Single Disagreement Recorded",
  "Scientists Confirm Workspace Still Exists, Just Very Quietly",
  "Empty Inbox, Tidy Docos, Rested Agents: A Study in Balance",
  "This Space Intentionally Left Blank by the Whole Team",
  "Fortune Teller Foresees Busier Days Ahead",
  "Team Lets Ideas Marinate; Chefs Applaud the Restraint",
  "Big Story Expected Any Minute Now, Reporters Insist",
];

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const clock = new Intl.DateTimeFormat("en-US", {
  timeZone: DIGEST_TIME_ZONE,
  hourCycle: "h23",
  hour: "numeric",
  weekday: "long",
});

/** The hour and weekday it is in Pacific Time at `at`. */
function pacific(at: Date): { hour: number; weekday: string } {
  const parts = Object.fromEntries(clock.formatToParts(at).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), weekday: parts.weekday };
}

/** The editions that go out at `at`: at midnight Pacific Time the daily one,
 *  and on Mondays the weekly; at any other hour none. */
export function settingsDue(at: Date): Cadence[] {
  const { hour, weekday } = pacific(at);
  if (hour !== 0) return [];
  return weekday === "Monday" ? ["daily", "weekly"] : ["daily"];
}

/** The time an edition sent at `at`, a midnight, covers: from the midnight a
 *  day (or a week) before. Across a change of daylight saving time that is 23
 *  or 25 hours a day, so the day before lands an hour off midnight and is
 *  moved onto it. */
export function digestPeriod(cadence: Cadence, at: Date): { since: string; until: string } {
  const before = new Date(at.getTime() - (cadence === "daily" ? 1 : 7) * DAY_MS);
  const { hour } = pacific(before);
  const since = new Date(before.getTime() + (hour >= 12 ? 24 - hour : -hour) * HOUR_MS);
  return { since: since.toISOString(), until: at.toISOString() };
}

/** The time an edition covers, as its email says it. */
export function periodLabel(cadence: Cadence): string {
  return cadence === "daily" ? "yesterday" : "last week";
}

const dateline = new Intl.DateTimeFormat("en-US", {
  timeZone: DIGEST_TIME_ZONE,
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});

/** The edition's date: the day it comes out, in Pacific Time. */
export function editionDate(at: Date): string {
  return dateline.format(at);
}

/** The newspaper of a workspace: The Acme Times, and for The Agency, The
 *  Agency Times. */
export function timesTitle(workspaceName: string): string {
  return `The ${workspaceName.trim().replace(/^the\s+/i, "")} Times`;
}

const count = (n: number) => n.toLocaleString("en-US");
const actorLine = (a: TopActor) => `${a.username} ${viaLabel(a.via)}: ${count(a.count)}`;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function digestEmail(opts: {
  baseUrl: string;
  workspaceHandle: string;
  /** The Acme Times (timesTitle). */
  title: string;
  /** Where the masthead of `title` is (lib/masthead.server.ts). */
  masthead: string;
  setting: Cadence;
  /** When the edition goes out. */
  at: Date;
  summary: ActivitySummary;
  /** The stories the member may read, the most important first. */
  stories: Story[];
  /** Names the member to /digest/<setting> (lib/activity-digest.server.ts). */
  token: string;
}): Omit<Email, "to"> {
  const { workspaceHandle: ws, title, setting, summary: s, stories } = opts;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const url = `${base}/workspaces/${ws}`;
  const t = new URLSearchParams({ t: opts.token });
  const other = setting === "daily" ? "weekly" : "daily";
  const switchUrl = `${base}/digest/${other}?${t}`;
  const unsubscribeUrl = `${base}/digest/unsubscribe?${t}`;
  const period = periodLabel(setting);
  const none = `None ${period}.`;
  const edition = `${capitalize(setting)} edition`;
  const date = editionDate(opts.at);
  const numbersTitle = `${capitalize(period)} in ${ws}`;
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
  // The lead and the two beside it; on a quiet day, a slow-news item alone.
  const quiet = stories.length === 0 && s.queries + s.writes + s.imports === 0;
  const front = quiet
    ? [
        {
          kicker: setting === "daily" ? "Slow news day" : "Slow news week",
          headline: SLOW_NEWS[Math.floor(opts.at.getTime() / DAY_MS) % SLOW_NEWS.length],
          takeaway: `Nobody queried, wrote or imported anything in ${ws} ${period}.`,
          url,
        },
      ]
    : stories.slice(0, 3).map((i) => ({
        kicker: `${capitalize(i.nodeType)} · ${i.docoHandle}`,
        headline: i.headline,
        takeaway: i.takeaway,
        url: i.url,
      }));
  const [lead, ...beside] = front;
  const briefs = stories.slice(3);
  const switchLabel = `Switch to ${other}`;
  const footer = `You get ${title} ${setting === "daily" ? "every day" : "every Monday"} as a member of ${ws}.`;

  const text = [
    `${title}\n${edition} · ${date}`,
    ...front.map((i) =>
      [i.headline, i.takeaway, `${i.kicker}: ${i.url}`].filter(Boolean).join("\n"),
    ),
    ...(briefs.length > 0
      ? [
          ["In brief", ...briefs.map((i) => `- ${i.headline} (${i.docoHandle}: ${i.url})`)].join(
            "\n",
          ),
        ]
      : []),
    `${numbersTitle}\n${stats.map((st) => `${st.value} ${st.label}`).join(" · ")}`,
    ...lists.map(([heading, lines]) =>
      [heading, ...(lines.length > 0 ? lines : [none]).map((l) => `- ${l}`)].join("\n"),
    ),
    `Open ${ws}: ${url}`,
    `${switchLabel}: ${switchUrl}`,
    `${footer} Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n\n");

  const story = (i: (typeof front)[number], lead = false): EmailBlock => ({
    kicker: i.kicker,
    headline: i.headline,
    text: i.takeaway,
    link: i.url,
    lead,
  });
  const blocks: EmailBlock[] = [
    { image: opts.masthead, alt: title },
    { dateline: [edition, date, "Doco"] },
    ...(lead ? [story(lead, true)] : []),
    ...(beside.length > 0 ? [{ columns: beside.map((i) => [story(i)]) }] : []),
    ...(briefs.length > 0
      ? [
          { heading: "In brief" },
          { list: briefs.map((i) => ({ text: i.headline, link: i.url, label: i.docoHandle })) },
        ]
      : []),
    { heading: numbersTitle },
    { stats },
    {
      columns: lists.map(([heading, lines]): EmailBlock[] => [
        { heading },
        lines.length > 0 ? { list: lines } : none,
      ]),
    },
    { link: url, label: `Open ${ws}` },
    { link: switchUrl, label: switchLabel, quiet: true },
    { footer, link: unsubscribeUrl, label: "Unsubscribe" },
  ];

  return {
    subject: `${title} · ${date}`,
    text: `${text}\n`,
    html: emailHtml(blocks),
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}
