// Real-database exercise of the feedback report queries that power the
// header bug/lightbulb flags and the feedback page's clear buttons. Points
// `@doco/db`'s `withClient` at an in-process PGlite loaded with the REAL
// schema, so the pending-count aggregate and the clear (archive) UPDATE run
// against actual Postgres semantics.

import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import {
  type FeedbackReportType,
  clearFeedbackReports,
  countPendingFeedback,
  createFeedbackReport,
} from "../feedback-reports.server";

const REPORTER = "user_reporter000000000000000000";

async function seedUser(): Promise<void> {
  await dbm.db.query("INSERT INTO users (id, data) VALUES ($1, '{}')", [REPORTER]);
}

async function report(report_type: FeedbackReportType, body: string) {
  return createFeedbackReport({
    input: {
      report_type,
      title: "",
      body,
      expected: "",
      actual: "",
      severity: "medium",
      page_url: "https://doco.to/workspaces",
      route_path: "/workspaces",
      client_context: {},
      data: {},
    },
    createdBy: REPORTER,
    createdByUsername: "doco-test-harness",
    serverContext: {},
  });
}

describe("feedback pending counts + clearing", () => {
  beforeEach(async () => {
    dbm.db = await freshDb();
    await seedUser();
  });

  it("counts uncleared bugs and ideas separately, starting at zero", async () => {
    expect(await countPendingFeedback()).toEqual({ bugs: 0, ideas: 0 });

    await report("bug", "first bug");
    await report("bug", "second bug");
    await report("idea", "an idea");

    expect(await countPendingFeedback()).toEqual({ bugs: 2, ideas: 1 });
  });

  it("clearing bugs archives only bugs and leaves ideas pending", async () => {
    await report("bug", "a bug");
    await report("idea", "an idea");

    const cleared = await clearFeedbackReports("bug", REPORTER);

    expect(cleared).toBe(1);
    expect(await countPendingFeedback()).toEqual({ bugs: 0, ideas: 1 });
  });

  it("clearing ideas archives only ideas and leaves bugs pending", async () => {
    await report("bug", "a bug");
    await report("idea", "an idea");

    const cleared = await clearFeedbackReports("idea", REPORTER);

    expect(cleared).toBe(1);
    expect(await countPendingFeedback()).toEqual({ bugs: 1, ideas: 0 });
  });

  it("clearing stamps reviewer + archived status and is a no-op the second time", async () => {
    const created = await report("bug", "a bug");

    const first = await clearFeedbackReports("bug", REPORTER);
    expect(first).toBe(1);

    const rows = await dbm.db.query<{
      status: string;
      reviewed_by: string | null;
      reviewed_at: string | null;
    }>("SELECT status, reviewed_by, reviewed_at FROM feedback_reports WHERE id = $1", [created.id]);
    expect(rows.rows[0].status).toBe("archived");
    expect(rows.rows[0].reviewed_by).toBe(REPORTER);
    expect(rows.rows[0].reviewed_at).not.toBeNull();

    // Re-clearing touches nothing — already archived.
    expect(await clearFeedbackReports("bug", REPORTER)).toBe(0);
  });

  it('"all" clears bugs and ideas in one sweep', async () => {
    await report("bug", "a bug");
    await report("idea", "an idea");

    const cleared = await clearFeedbackReports("all", REPORTER);

    expect(cleared).toBe(2);
    expect(await countPendingFeedback()).toEqual({ bugs: 0, ideas: 0 });
  });
});
