// Real-database exercise of searchConversationsByMessageText — points
// `@doco/db`'s `withClient` at an in-process PGlite loaded with the REAL schema,
// so the ILIKE-over-jsonb search runs against actual Postgres semantics. The
// point: an agent handed a remembered quote ("the wiring doesn't match the BPM
// file") can locate the exact conversation id, with metacharacters treated
// literally.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(join(here, "../../../../db/src/schema.sql"), "utf8");

const dbm = vi.hoisted(() => ({ db: null as unknown as InstanceType<typeof PGlite> }));

vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(dbm.db),
}));

import { searchConversationsByMessageText } from "../agent-debug.server";

const USER = "user_dbg00000000000000000000";

let msgSeq = 0;
async function seedConversation(id: string, texts: string[]): Promise<void> {
  await dbm.db.query("INSERT INTO chat_conversations (id, user_id, title) VALUES ($1,$2,$3)", [
    id,
    USER,
    `thread ${id}`,
  ]);
  for (const t of texts) {
    msgSeq += 1;
    await dbm.db.query(
      `INSERT INTO chat_messages (id, conversation_id, role, content, created_at)
         VALUES ($1,$2,'user',$3, now() + ($4 || ' seconds')::interval)`,
      [
        `msg_${String(msgSeq).padStart(6, "0")}`,
        id,
        JSON.stringify([{ type: "text", text: t }]),
        String(msgSeq),
      ],
    );
  }
}

describe("searchConversationsByMessageText (real DB)", () => {
  beforeEach(async () => {
    dbm.db = new PGlite();
    await dbm.db.exec(schemaSql);
    await dbm.db.query(`INSERT INTO users (id, data) VALUES ($1, '{}'::jsonb)`, [USER]);
  });

  it("finds the conversation whose message contains the phrase", async () => {
    await seedConversation("conversation_match", [
      "hello there",
      "but wait, the wiring doesn't match the BPM file I gave you",
    ]);
    await seedConversation("conversation_other", ["totally unrelated chatter"]);

    const hits = await searchConversationsByMessageText("wiring doesn't match the BPM");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      conversation_id: "conversation_match",
      user_id: USER,
      match_count: 1,
    });
  });

  it("is case-insensitive and returns nothing for an absent phrase", async () => {
    await seedConversation("conversation_x", ["The BPMN diagram is attached"]);
    expect(await searchConversationsByMessageText("bpmn diagram")).toHaveLength(1);
    expect(await searchConversationsByMessageText("no such phrase here")).toHaveLength(0);
  });

  it("treats LIKE metacharacters in the query literally", async () => {
    await seedConversation("conversation_pct", ["we are 100% done"]);
    await seedConversation("conversation_plain", ["we are 100 done"]);
    // "100%" must match only the literal-percent message, not act as a wildcard.
    const hits = await searchConversationsByMessageText("100%");
    expect(hits.map((h) => h.conversation_id)).toEqual(["conversation_pct"]);
  });
});
