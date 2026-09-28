// The Slack bot token is a workspace-wide credential (and, with channel
// mirroring, one that can read every public channel). It is stored encrypted:
// a database dump alone must not yield a working token. PGlite backs the real
// install + read SQL.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

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

import { getSlackBotToken, upsertSlackInstallation } from "../slack.server";

async function storedToken(team: string): Promise<string | null> {
  const r = await dbm.db.query<{ bot_access_token: string | null }>(
    "SELECT bot_access_token FROM group_chat_installations WHERE provider = 'slack' AND workspace_id = $1",
    [team],
  );
  return r.rows[0]?.bot_access_token ?? null;
}

beforeEach(async () => {
  process.env.DOCO_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  dbm.db = new PGlite({ extensions: { vector } });
  await dbm.db.exec(schemaSql);
});
afterEach(() => {
  process.env.DOCO_ENCRYPTION_KEY = undefined;
});

describe("Slack bot token at rest", () => {
  it("stores the token encrypted and reads it back in plaintext", async () => {
    await upsertSlackInstallation({
      response: {
        ok: true,
        access_token: "xoxb-live-token",
        bot_user_id: "U1",
        scope: "chat:write",
        team: { id: "T1", name: "Acme" },
      },
      installedByUserId: null,
      docoWorkspaceId: "workspace_1",
    });

    expect(await storedToken("T1")).not.toContain("xoxb");
    expect(await getSlackBotToken("T1")).toBe("xoxb-live-token");
  });

  it("encrypts a token stored in plaintext before encryption shipped, on first read", async () => {
    await dbm.db.query(
      `INSERT INTO group_chat_installations (id, provider, workspace_id, bot_access_token)
       VALUES ('gci_1', 'slack', 'T2', 'xoxb-legacy')`,
    );

    expect(await getSlackBotToken("T2")).toBe("xoxb-legacy");
    expect(await storedToken("T2")).not.toContain("xoxb");
    expect(await getSlackBotToken("T2")).toBe("xoxb-legacy");
  });
});
