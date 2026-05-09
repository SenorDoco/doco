import type { Database } from "better-sqlite3";
import { matches } from "@evalo/runtime";
import type { Glossary } from "./glossary.js";

export type DiscoveryTier = "precise" | "related" | "possibly-relevant";

export interface DiscoveryHit {
  rule_id: string;
  rule_slug: string | null;
  modality: string;
  phase: string;
  summary: string;
  tier: DiscoveryTier;
  strategy: "structural" | "tag" | "fts" | "glossary";
  reason?: string;
  score?: number;
}

export interface FindRulesQuery {
  /** A description of the work item, used for FTS/glossary expansion. */
  description?: string;
  /** Tags carried by the candidate work item (used for tag-overlap). */
  tags?: string[];
  /** A free-form candidate object whose shape resembles a draft Action or entity. */
  candidate?: Record<string, unknown>;
}

export interface FindRulesResult {
  precise: DiscoveryHit[];
  related: DiscoveryHit[];
  possiblyRelevant: DiscoveryHit[];
}

/**
 * Five-strategy retrieval per ADR-030. Strategies 1-3 are precision-tight
 * (block on `must` violations); 4-5 are advisory.
 *
 * For v0:
 *   - Strategy 1 (structural): evaluate Rule.applies_to selector vs the candidate
 *   - Strategy 2 (tag overlap): Rules tagged with any tag carried by the candidate
 *   - Strategy 3 (reference-graph): deferred
 *   - Strategy 4 (semantic): FTS5 over Rule summary + body
 *   - Strategy 5 (glossary): expand the description through glossary.yaml
 */
export function findRules(
  db: Database,
  glossary: Glossary,
  query: FindRulesQuery,
): FindRulesResult {
  const precise: DiscoveryHit[] = [];
  const related: DiscoveryHit[] = [];
  const possiblyRelevant: DiscoveryHit[] = [];
  const seen = new Set<string>();

  // Strategy 1: structural match
  if (query.candidate) {
    const ruleRows = db
      .prepare(
        "SELECT id, slug, modality, phase, summary, raw_json FROM rule WHERE lifecycle = 'active'",
      )
      .all() as { id: string; slug: string | null; modality: string; phase: string; summary: string; raw_json: string }[];
    for (const r of ruleRows) {
      const rule = JSON.parse(r.raw_json) as Record<string, unknown>;
      const ok = matches(rule.applies_to as unknown, query.candidate, db);
      if (ok && !seen.has(r.id)) {
        precise.push({
          rule_id: r.id,
          rule_slug: r.slug,
          modality: r.modality,
          phase: r.phase,
          summary: r.summary,
          tier: "precise",
          strategy: "structural",
        });
        seen.add(r.id);
      }
    }
  }

  // Strategy 2: tag overlap
  if (query.tags && query.tags.length > 0) {
    const tagIdRows = db.prepare("SELECT id FROM tag WHERE name IN (" + query.tags.map(() => "?").join(",") + ")")
      .all(...query.tags) as { id: string }[];
    if (tagIdRows.length > 0) {
      const tagIds = tagIdRows.map((t) => t.id);
      const placeholders = tagIds.map(() => "?").join(",");
      const ruleRows = db
        .prepare(
          `SELECT DISTINCT r.id, r.slug, r.modality, r.phase, r.summary
           FROM rule r JOIN edges e ON e.from_id = r.id AND e.edge_type = 'tagged'
           WHERE r.lifecycle = 'active' AND e.to_id IN (${placeholders})`,
        )
        .all(...tagIds) as { id: string; slug: string | null; modality: string; phase: string; summary: string }[];
      for (const r of ruleRows) {
        if (seen.has(r.id)) continue;
        related.push({
          rule_id: r.id,
          rule_slug: r.slug,
          modality: r.modality,
          phase: r.phase,
          summary: r.summary,
          tier: "related",
          strategy: "tag",
        });
        seen.add(r.id);
      }
    }
  }

  // Strategy 4 + 5: FTS5 with glossary expansion
  if (query.description && query.description.trim().length > 0) {
    const expanded = glossary.expand(query.description);
    if (expanded.length > 0) {
      const ftsQuery = expanded.join(" OR ");
      const rows = db
        .prepare(
          `SELECT fts.id AS id, r.slug, r.modality, r.phase, r.summary, fts.rank
           FROM fts
           JOIN rule r ON r.id = fts.id
           WHERE fts MATCH ? AND r.lifecycle = 'active'
           ORDER BY fts.rank LIMIT 10`,
        )
        .all(ftsQuery) as {
        id: string;
        slug: string | null;
        modality: string;
        phase: string;
        summary: string;
        rank: number;
      }[];
      for (const r of rows) {
        if (seen.has(r.id)) continue;
        possiblyRelevant.push({
          rule_id: r.id,
          rule_slug: r.slug,
          modality: r.modality,
          phase: r.phase,
          summary: r.summary,
          tier: "possibly-relevant",
          strategy: "fts",
          reason: `FTS match (rank ${r.rank.toFixed(2)})`,
          score: r.rank,
        });
        seen.add(r.id);
      }
    }
  }

  return { precise, related, possiblyRelevant };
}
