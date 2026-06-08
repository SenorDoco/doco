// Real-database exercise of the live-feed change cursor.
//
// Points readChangeCursor at an in-process PGlite loaded with the REAL schema,
// so the (doco_id, at DESC) latest-event lookup runs against actual Postgres
// semantics. Every node alteration writes an audit_events row, so the latest
// event id is a complete "has anything changed?" signal for a Doco.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { readChangeCursor } from "../change-cursor.server";

type Client = Parameters<typeof readChangeCursor>[0];

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

async function seed(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(schemaSql);
  await db.query("INSERT INTO workspaces (id, handle, name) VALUES ('workspace_1', 'ws', 'WS')");
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_1','d','workspace_1','workspace_1','{}'::jsonb)",
  );
  await db.query(
    "INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES ('doco_2','e','workspace_1','workspace_1','{}'::jsonb)",
  );
  return db;
}

async function addEvent(
  db: PGlite,
  opts: { eventId: string; docoId: string; minutesAgo: number; op?: string },
): Promise<void> {
  await db.query(
    `INSERT INTO audit_events (event_id, at, doco_id, workspace_id, entity_type, entity_id, op)
     VALUES ($1, now() - ($2 || ' minutes')::interval, $3, 'workspace_1', 'decision', 'decision_x', $4)`,
    [opts.eventId, String(opts.minutesAgo), opts.docoId, opts.op ?? "entity.update"],
  );
}

describe("readChangeCursor against a real database", () => {
  it("returns null when the Doco has no audit events yet", async () => {
    const db = await seed();
    expect(await readChangeCursor(db as Client, "doco_1")).toBeNull();
  });

  it("returns the most recent event id for the Doco", async () => {
    const db = await seed();
    await addEvent(db, { eventId: "event_oldest", docoId: "doco_1", minutesAgo: 30 });
    await addEvent(db, { eventId: "event_middle", docoId: "doco_1", minutesAgo: 20 });
    await addEvent(db, { eventId: "event_newest", docoId: "doco_1", minutesAgo: 1 });
    expect(await readChangeCursor(db as Client, "doco_1")).toBe("event_newest");
  });

  it("advances when any kind of alteration is recorded", async () => {
    const db = await seed();
    await addEvent(db, {
      eventId: "event_create",
      docoId: "doco_1",
      minutesAgo: 10,
      op: "entity.create",
    });
    const before = await readChangeCursor(db as Client, "doco_1");
    await addEvent(db, { eventId: "event_edge", docoId: "doco_1", minutesAgo: 1, op: "edge.add" });
    const after = await readChangeCursor(db as Client, "doco_1");
    expect(before).toBe("event_create");
    expect(after).toBe("event_edge");
    expect(after).not.toBe(before);
  });

  it("is scoped to the Doco — another Doco's events never leak in", async () => {
    const db = await seed();
    await addEvent(db, { eventId: "event_doco1", docoId: "doco_1", minutesAgo: 10 });
    // A newer event on a different Doco must not become doco_1's cursor.
    await addEvent(db, { eventId: "event_doco2", docoId: "doco_2", minutesAgo: 1 });
    expect(await readChangeCursor(db as Client, "doco_1")).toBe("event_doco1");
    expect(await readChangeCursor(db as Client, "doco_2")).toBe("event_doco2");
  });
});
