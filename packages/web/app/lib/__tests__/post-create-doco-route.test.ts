import { describe, expect, it } from "vitest";

import {
  readCreatedDocoChatIdSearchParams,
  withCreatedDocoChatId,
  withCreatedDocoId,
} from "../post-create-doco-route";

describe("post-create Doco route helpers", () => {
  it("carries both the created Doco id and companion chat id", () => {
    const url = withCreatedDocoChatId(
      withCreatedDocoId("/fresh-doco/welcome?from=dashboard", "doco_01KSJZ35Y5H6HA7WF75JWMY7J4"),
      "conv_01KSJZ35Y5H6HA7WF75JWMY7J5",
    );

    expect(url).toBe(
      "/fresh-doco/welcome?from=dashboard&created_doco_id=doco_01KSJZ35Y5H6HA7WF75JWMY7J4&created_chat_id=conv_01KSJZ35Y5H6HA7WF75JWMY7J5",
    );
  });

  it("ignores invalid companion chat ids", () => {
    const params = new URLSearchParams("created_chat_id=chat-not-valid");
    expect(readCreatedDocoChatIdSearchParams(params)).toBeNull();
  });
});
