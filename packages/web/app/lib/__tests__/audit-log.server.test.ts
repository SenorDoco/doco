import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendAuditEventRow: vi.fn(),
  readAuditEventRows: vi.fn(),
}));

vi.mock("@doco/db", () => ({
  appendAuditEventRow: mocks.appendAuditEventRow,
  readAuditEventRows: mocks.readAuditEventRows,
}));

import { readAuditEvents } from "../audit-log.server";

describe("readAuditEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readAuditEventRows.mockResolvedValue([]);
  });

  it("passes before through as an audit pagination cursor", async () => {
    await readAuditEvents(
      "/tmp/doco",
      {
        before: "2026-05-27T13:33:27.000Z",
        limit: 200,
      },
      "doco_bpms",
    );

    expect(mocks.readAuditEventRows).toHaveBeenCalledWith(
      expect.objectContaining({
        doco_id: "doco_bpms",
        before: "2026-05-27T13:33:27.000Z",
        limit: 200,
      }),
    );
  });
});
