import { describe, expect, it } from "vitest";

import { readCreatedDocoChatIdSearchParams, withCreatedDocoId } from "../post-create-doco-route";

describe("post-create Doco route helpers", () => {
  it("carries the created Doco id without a companion chat id", () => {
    const url = withCreatedDocoId(
      "/fresh-doco/welcome?from=dashboard",
      "doco_01KSJZ35Y5H6HA7WF75JWMY7J4",
    );

    expect(url).toBe(
      "/fresh-doco/welcome?from=dashboard&created_doco_id=doco_01KSJZ35Y5H6HA7WF75JWMY7J4",
    );
  });

  it("ignores invalid companion chat ids", () => {
    const params = new URLSearchParams("created_chat_id=chat-not-valid");
    expect(readCreatedDocoChatIdSearchParams(params)).toBeNull();
  });
});
