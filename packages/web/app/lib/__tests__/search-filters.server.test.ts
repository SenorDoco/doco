import { describe, expect, it } from "vitest";
import { computeFilterFacets } from "../search-filters.server";

describe("computeFilterFacets", () => {
  it("includes live edge type facets ordered by count", async () => {
    const client = {
      async query<T>(sql: string) {
        if (sql.includes("FROM edges")) {
          return {
            rows: [
              {
                value: "serves",
                n: "4",
                updated_at: "2026-05-31T18:00:00.000Z",
              },
              {
                value: "sequence_flow",
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
        value: "serves",
        count: 4,
        updatedAt: "2026-05-31T18:00:00.000Z",
      },
      {
        value: "sequence_flow",
        count: 2,
        updatedAt: "2026-05-31T17:00:00.000Z",
      },
    ]);
  });
});
