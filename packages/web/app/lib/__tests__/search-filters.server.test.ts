import { describe, expect, it } from "vitest";
import { computeFilterFacets } from "../search-filters.server";

describe("computeFilterFacets", () => {
  it("computes node facets with bounded aggregate queries instead of per-type scans", async () => {
    const queries: string[] = [];
    const client = {
      async query<T>(sql: string) {
        queries.push(sql);
        if (/GROUP BY node_type, value/i.test(sql)) {
          return {
            rows: [
              {
                node_type: "decision",
                value: "asserted",
                n: "2",
                updated_at: "2026-05-31T18:00:00.000Z",
              },
              {
                node_type: "intent",
                value: "drafting",
                n: "1",
                updated_at: "2026-05-31T17:00:00.000Z",
              },
            ] as T[],
          };
        }
        if (/GROUP BY node_type/i.test(sql)) {
          return {
            rows: [
              {
                node_type: "decision",
                n: "2",
                drafting_n: "0",
                asserted_n: "2",
                retired_n: "0",
                updated_at: "2026-05-31T18:00:00.000Z",
              },
              {
                node_type: "intent",
                n: "1",
                drafting_n: "1",
                asserted_n: "0",
                retired_n: "0",
                updated_at: "2026-05-31T17:00:00.000Z",
              },
            ] as T[],
          };
        }
        return { rows: [] as T[] };
      },
    };

    const facets = await computeFilterFacets(client as never, "doco_01");

    expect(queries.filter((sql) => /FROM nodes/i.test(sql))).toHaveLength(2);
    expect(facets.lifecycle).toEqual([
      { value: "drafting", count: 1, updatedAt: "2026-05-31T17:00:00.000Z" },
      { value: "asserted", count: 2, updatedAt: "2026-05-31T18:00:00.000Z" },
    ]);
    expect(facets.entityType).toEqual([
      {
        value: "decision",
        count: 2,
        counts: { drafting: 0, asserted: 2, retired: 0 },
        updatedAt: "2026-05-31T18:00:00.000Z",
      },
      {
        value: "intent",
        count: 1,
        counts: { drafting: 1, asserted: 0, retired: 0 },
        updatedAt: "2026-05-31T17:00:00.000Z",
      },
    ]);
  });

  it("includes live edge type facets ordered by count", async () => {
    const client = {
      async query<T>(sql: string) {
        if (sql.includes("FROM edges")) {
          return {
            rows: [
              {
                value: "supports",
                n: "4",
                updated_at: "2026-05-31T18:00:00.000Z",
              },
              {
                value: "flows_to",
                n: "2",
                updated_at: "2026-05-31T17:00:00.000Z",
              },
            ] as T[],
          };
        }

        return { rows: [] as T[] };
      },
    };

    const facets = await computeFilterFacets(client as never, "doco_01");

    expect(facets.edgeType).toEqual([
      {
        value: "supports",
        count: 4,
        updatedAt: "2026-05-31T18:00:00.000Z",
      },
      {
        value: "flows_to",
        count: 2,
        updatedAt: "2026-05-31T17:00:00.000Z",
      },
    ]);
  });
});
