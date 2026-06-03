// Real-database exercise of the one-time Slack channel intro. Points
// @doco/db's withClient at an in-process PGlite loaded with the REAL schema
// and proves that markSlackChannelIntroducedIfFirst returns true exactly once
// per (workspace, channel), so Señor Doco leads its FIRST message in a channel
// with the Haiku/MCP intro and never repeats it. Also pins the intro copy.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  DOCO_NODE_TABLE_SPECS: [],
  DOCO_GENERIC_CAPTURE_NODE_TABLE_SPECS: [],
  getUserById: vi.fn(),
  getEntity: vi.fn(),
  listDocoUsers: vi.fn(),
  listEntitiesByDoco: vi.fn(),
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));
vi.mock("../doco-access.server", () => ({
  listAccessibleDocoIdsInWorkspace: vi.fn(),
  getDocoLevelRole: vi.fn(),
}));

import { buildSlackChannelIntroLine, markSlackChannelIntroducedIfFirst } from "../slack.server";

describe("markSlackChannelIntroducedIfFirst (real DB)", () => {
  beforeEach(async () => {
    dbm.db = new PGlite();
    await dbm.db.exec(schemaSql);
  });

  it("is true the first time a channel speaks, false every time after", async () => {
    expect(await markSlackChannelIntroducedIfFirst({ workspaceId: "T1", channelId: "C1" })).toBe(
      true,
    );
    expect(await markSlackChannelIntroducedIfFirst({ workspaceId: "T1", channelId: "C1" })).toBe(
      false,
    );
    expect(await markSlackChannelIntroducedIfFirst({ workspaceId: "T1", channelId: "C1" })).toBe(
      false,
    );
  });

  it("tracks each channel and workspace independently", async () => {
    expect(await markSlackChannelIntroducedIfFirst({ workspaceId: "T1", channelId: "C1" })).toBe(
      true,
    );
    expect(await markSlackChannelIntroducedIfFirst({ workspaceId: "T1", channelId: "C2" })).toBe(
      true,
    );
    expect(await markSlackChannelIntroducedIfFirst({ workspaceId: "T2", channelId: "C1" })).toBe(
      true,
    );
    // The already-introduced (T1, C1) channel is still suppressed.
    expect(await markSlackChannelIntroducedIfFirst({ workspaceId: "T1", channelId: "C1" })).toBe(
      false,
    );
  });
});

describe("buildSlackChannelIntroLine", () => {
  it("states the Haiku scope and links the tokens page on the request origin", () => {
    expect(buildSlackChannelIntroLine("https://example.test")).toBe(
      "I use Haiku and can handle simple stuff. For complex stuff, connect your agent with Doco's MCP <https://example.test/tokens>",
    );
  });

  it("falls back to the production host when no origin is given", () => {
    expect(buildSlackChannelIntroLine()).toContain("<https://doco.to/tokens>");
  });
});
