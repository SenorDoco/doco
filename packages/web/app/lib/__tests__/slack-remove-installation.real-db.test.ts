// Real-database exercise of removeSlackInstallation. Points @doco/db's
// withClient at an in-process PGlite loaded with the REAL schema, seeds the
// three group_chat_* tables for two Slack teams, and proves that removing one
// team clears its install + channel defaults + personal links transactionally,
// leaves the other team untouched, and is idempotent for an unknown team.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  DOCO_NODE_TABLE_SPECS: [],
  DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS: [],
  getUserById: vi.fn(),
  getEntity: vi.fn(),
  listDocoUsers: vi.fn(),
  listNodesByDoco: vi.fn(),
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));
vi.mock("../doco-access.server", () => ({
  listAccessibleDocoIdsInWorkspace: vi.fn(),
  getDocoLevelRole: vi.fn(),
}));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import { removeSlackInstallation } from "../slack.server";

async function countFor(team: string): Promise<{
  installs: number;
  channels: number;
  links: number;
}> {
  const q = async (table: string) =>
    (
      await dbm.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table} WHERE provider = 'slack' AND workspace_id = $1`,
        [team],
      )
    ).rows[0].n;
  return {
    installs: await q("group_chat_installations"),
    channels: await q("group_chat_channel_connections"),
    links: await q("group_chat_user_links"),
  };
}

async function seedSlackState(team: string): Promise<void> {
  await dbm.db.query(
    "INSERT INTO group_chat_installations (id, provider, workspace_id) VALUES ($1,'slack',$2)",
    [`gci_${team}`, team],
  );
  await dbm.db.query(
    `INSERT INTO group_chat_channel_connections
       (id, provider, workspace_id, channel_id, target_level, target_id, role)
     VALUES ($1,'slack',$2,'*','workspace','workspace_x','reader')`,
    [`gcc_${team}`, team],
  );
  await dbm.db.query(
    "INSERT INTO group_chat_user_links (id, provider, workspace_id, chat_user_id, user_id) VALUES ($1,'slack',$2,'U1','user_alice')",
    [`gcul_${team}`, team],
  );
}

describe("removeSlackInstallation (real DB)", () => {
  beforeEach(async () => {
    dbm.db = await freshDb();
    await dbm.db.query("INSERT INTO users (id, data) VALUES ('user_alice', '{}')");
    await seedSlackState("T_REMOVE");
    await seedSlackState("T_KEEP");
  });

  it("clears the install and every related row for the team, leaving others intact", async () => {
    const removed = await removeSlackInstallation("T_REMOVE");
    expect(removed).toBe(true);
    expect(await countFor("T_REMOVE")).toEqual({ installs: 0, channels: 0, links: 0 });
    // A different Slack team's install, defaults, and links are untouched.
    expect(await countFor("T_KEEP")).toEqual({ installs: 1, channels: 1, links: 1 });
  });

  it("returns false for a team that has no installation (idempotent)", async () => {
    const removed = await removeSlackInstallation("T_GONE");
    expect(removed).toBe(false);
    expect(await countFor("T_KEEP")).toEqual({ installs: 1, channels: 1, links: 1 });
  });
});
