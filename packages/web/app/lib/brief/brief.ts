// The Doco brief, pure parts. An agent about to act says what it is about to
// do (`about`) and what it touches (`touching`); the brief answers across
// every Doco it can read in four tiers: what it must obey, what is already
// decided, what is in motion, and background. Each item says why it is there
// and carries an id the agent cites in what it captures. The engine
// (brief.server.ts) fills these from the database; everything here is pure.

export type BriefTier = "must_obey" | "decided" | "in_motion" | "background";

export const BRIEF_TIERS: readonly BriefTier[] = [
  "must_obey",
  "decided",
  "in_motion",
  "background",
];

export const BRIEF_TIER_LABELS: Record<BriefTier, string> = {
  must_obey: "Must obey",
  decided: "Already decided",
  in_motion: "In motion",
  background: "Background",
};

/** Tokens a brief may take when the caller sets no budget. */
export const DEFAULT_BRIEF_BUDGET = 4000;
/** How far back "in motion" reaches when the caller gives no `since`. */
export const IN_MOTION_DAYS = 7;
/** Prose an expanded item carries; the rest is a click away through its id. */
export const EXPANDED_CHARS = 1200;
/** Expanded items fill this share of the budget; compact lines fill the rest. */
export const EXPANDED_SHARE = 0.6;
/** Rules are all standing orders while a workspace has at most this many. */
export const STANDING_RULES_MAX = 10;

export type TouchKind = "path" | "url" | "node" | "pr";

export interface Touch {
  kind: TouchKind;
  value: string;
}

const NODE_ID =
  /^(?:intent|idea|rule|decision|action|log|eval|reference|state|principal|policy)_[0-9A-HJKMNP-TV-Z]{26}$/;
const PR_URL = /github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)/;

/**
 * What the agent names, parsed the way `node_touches_of` (schema.sql) parses
 * a node's prose, so the two sides meet: paths lose a leading "./" or "/" and
 * a ":line" suffix; a pull request is "#<number>", from a bare number, a
 * "#<number>" or a github.com/…/pull/<number> link (which is also a URL).
 */
export function parseTouching(touching: readonly string[]): Touch[] {
  const out = new Map<string, Touch>();
  const add = (kind: TouchKind, value: string) => {
    const key = `${kind}\n${value}`;
    if (!out.has(key)) out.set(key, { kind, value });
  };
  for (const raw of touching) {
    const s = raw.trim();
    if (!s) continue;
    if (/^https?:\/\//.test(s)) {
      const url = s.replace(/[.,;:]+$/, "");
      add("url", url);
      const pr = PR_URL.exec(url);
      if (pr) add("pr", `#${pr[1]}`);
      continue;
    }
    if (/^#?\d{1,7}$/.test(s)) {
      add("pr", `#${s.replace(/^#/, "")}`);
      continue;
    }
    if (NODE_ID.test(s)) {
      add("node", s);
      continue;
    }
    const path = s.replace(/^(\.\/|\/)/, "").replace(/:\d+(-\d+)?$/, "");
    if (path) add("path", path);
  }
  return [...out.values()];
}

/** Why a candidate is in the brief: the ways it was found. */
export type Signal =
  | { kind: "named" }
  | { kind: "target" }
  | { kind: "standing" }
  | { kind: "touch"; value: string }
  | { kind: "term"; term: string }
  | { kind: "vector"; rank: number }
  | { kind: "fts"; rank: number }
  | { kind: "hop"; edge_type: string; via: string; direction: "out" | "in" }
  | { kind: "replaces"; old: string };

export interface Candidate {
  id: string;
  /** Doco handle, or null for a workspace constitution. */
  doco: string | null;
  /** A node type, or constitution | doco | policy | slack | notion. */
  type: string;
  lifecycle: string | null;
  text: string;
  url: string | null;
  updated_at: string | null;
  signals: Signal[];
}

export interface TierContext {
  /** Start of the "in motion" window, epoch milliseconds. */
  sinceMs: number;
}

/** The tier a candidate belongs to, or null when it has no place (retired). */
export function tierOf(c: Candidate, ctx: TierContext): BriefTier | null {
  if (c.lifecycle === "retired") return null;
  if (c.type === "constitution" || c.type === "doco" || c.type === "policy") return "must_obey";
  if (c.type === "rule") return c.lifecycle === "active" ? "must_obey" : "decided";
  if (c.type === "decision") {
    const binds =
      c.lifecycle === "active" && c.signals.some((s) => s.kind === "touch" || s.kind === "named");
    return binds ? "must_obey" : "decided";
  }
  const updated = c.updated_at ? Date.parse(c.updated_at) : Number.NaN;
  if (!Number.isNaN(updated) && updated >= ctx.sinceMs) return "in_motion";
  if (c.type === "reference" && c.lifecycle === "queued") return "in_motion";
  return "background";
}

const EDGE_WORDS: Record<string, string> = {
  flows_to: "flows to",
  supports: "supports",
  constrained_by: "is constrained by",
  attributed_to: "is attributed to",
  has_parent: "belongs under",
  derived_from: "derives from",
  replaces: "replaces",
  relates_to: "relates to",
};

/** One line saying why the candidate is in the brief. */
export function becauseOf(c: Candidate): string {
  const parts: string[] = [];
  const has = (kind: Signal["kind"]) => c.signals.some((s) => s.kind === kind);
  if (has("named")) parts.push("you named it");
  if (has("target")) parts.push("where you will write");
  if (has("standing")) parts.push("standing rule");
  const touches = c.signals.flatMap((s) => (s.kind === "touch" ? [s.value] : []));
  if (touches.length > 0) {
    const shown = touches.slice(0, 2).join(" and ");
    parts.push(
      touches.length > 2 ? `names ${shown} and ${touches.length - 2} more` : `names ${shown}`,
    );
  }
  for (const s of c.signals) if (s.kind === "term") parts.push(`defines "${s.term}"`);
  for (const s of c.signals)
    if (s.kind === "replaces") parts.push(`replaces ${s.old}, now retired`);
  const hop = c.signals.find((s) => s.kind === "hop");
  if (hop && hop.kind === "hop") {
    const words = EDGE_WORDS[hop.edge_type] ?? hop.edge_type.replace(/_/g, " ");
    parts.push(hop.direction === "out" ? `${words} ${hop.via}` : `${hop.via} ${words} it`);
  }
  if (has("vector")) parts.push("matches your ask");
  else if (has("fts")) parts.push("matches your words");
  if (c.lifecycle === "drafting") parts.push("still drafting");
  else if (c.lifecycle === "queued")
    parts.push(c.type === "reference" ? "open" : "queued, not yet active");
  return parts.join("; ");
}

export interface BriefItem {
  id: string;
  tier: BriefTier;
  type: string;
  doco: string | null;
  lifecycle: string | null;
  summary: string;
  text: string;
  because: string;
  url: string | null;
  updated_at: string | null;
  detail: "expanded" | "compact";
}

export interface Brief {
  brief_id: string;
  about: string;
  touching: string[];
  synthesis: string | null;
  items: BriefItem[];
  gaps: string[];
  held_back: number;
  budget: number;
  tokens_used: number;
  /** Milliseconds per step: embed, seeds, expand, rank, rerank, synthesize, total. */
  steps: Record<string, number>;
  warnings: string[];
}

/** Rough token count: four characters a token. */
export function tokensOf(text: string): number {
  return Math.ceil(text.length / 4);
}

export function summaryOf(text: string): string {
  const line =
    text
      .split("\n")
      .find((l) => l.trim() !== "")
      ?.trim() ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

export function expandedText(text: string): string {
  const t = text.trim();
  return t.length > EXPANDED_CHARS ? `${t.slice(0, EXPANDED_CHARS - 1)}…` : t;
}

/** An item as the text rendering prints it, compact or expanded. */
export function renderItem(item: Omit<BriefItem, "detail">, detail: BriefItem["detail"]): string {
  const where = [item.doco, item.lifecycle].filter(Boolean).join(" · ");
  const head = `- ${item.id}${where ? ` (${where})` : ""} — ${item.summary}`;
  const lines = [head, `  because: ${item.because}`];
  if (detail === "expanded") {
    const body = item.text.trim();
    if (body && body !== item.summary) lines.push(...body.split("\n").map((l) => `  ${l}`));
  }
  if (item.url) lines.push(`  ${item.url}`);
  return lines.join("\n");
}

/**
 * Fill the budget in tier order. Must-obey items are always served expanded;
 * the rest go expanded until EXPANDED_SHARE of the budget is used, then
 * compact, and stop at the first item that does not fit, which keeps the
 * served items a prefix of the ranking. `reserved` is what the synthesis and
 * the frame already take.
 */
export function fillBudget(
  items: readonly Omit<BriefItem, "detail">[],
  budget: number,
  reserved = 0,
): { served: BriefItem[]; held_back: number; tokens_used: number } {
  const served: BriefItem[] = [];
  let tokens = reserved;
  let i = 0;
  for (; i < items.length; i++) {
    const item = items[i];
    if (item.tier === "must_obey") {
      served.push({ ...item, detail: "expanded" });
      tokens += tokensOf(renderItem(item, "expanded"));
      continue;
    }
    let detail: BriefItem["detail"] = tokens < budget * EXPANDED_SHARE ? "expanded" : "compact";
    let cost = tokensOf(renderItem(item, detail));
    if (tokens + cost > budget && detail === "expanded") {
      detail = "compact";
      cost = tokensOf(renderItem(item, detail));
    }
    if (tokens + cost > budget) break;
    served.push({ ...item, detail });
    tokens += cost;
  }
  return { served, held_back: items.length - i, tokens_used: tokens };
}

/** The brief as text, the shape an agent reads straight into its context. */
export function renderBriefText(brief: Brief): string {
  const out: string[] = [];
  out.push(`Doco brief ${brief.brief_id}${brief.about ? ` · about: ${brief.about}` : ""}`);
  if (brief.touching.length > 0) out.push(`Touching: ${brief.touching.join(", ")}`);
  if (brief.synthesis) out.push("", brief.synthesis.trim());
  for (const tier of BRIEF_TIERS) {
    const items = brief.items.filter((item) => item.tier === tier);
    if (items.length === 0) continue;
    out.push("", `## ${BRIEF_TIER_LABELS[tier]}`);
    for (const item of items) out.push(renderItem(item, item.detail));
  }
  if (brief.gaps.length > 0) {
    out.push("", "## Gaps");
    for (const gap of brief.gaps) out.push(`- ${gap}`);
  }
  out.push("");
  const tail = [`Cite these ids in what you capture; brief ${brief.brief_id}.`];
  if (brief.held_back > 0)
    tail.push(`${brief.held_back} more held back by the budget of ${brief.budget} tokens.`);
  for (const warning of brief.warnings) tail.push(warning);
  out.push(tail.join(" "));
  return out.join("\n");
}
