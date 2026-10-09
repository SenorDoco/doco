import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@doco/db", () => ({ withClient: vi.fn() }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("~/lib/db.server", () => ({ docoPath: (h: string) => `/repos/${h}` }));

const { getDocoConnectionsContext, runBackfillSlice, resumeCursorFromConnections } = vi.hoisted(
  () => ({
    getDocoConnectionsContext: vi.fn(),
    runBackfillSlice: vi.fn(),
    // Stand-in: turn connections into a queued running cursor.
    resumeCursorFromConnections: vi.fn((conns: Array<{ repo: string }>) => ({
      status: "running",
      queue: conns.map((c) => c.repo),
      repo_index: 0,
      page: 1,
    })),
  }),
);
vi.mock("~/lib/github-connection.server", () => ({
  getDocoConnectionsContext,
  resumeCursorFromConnections,
}));
vi.mock("~/lib/github-backfill-driver.server", () => ({ runBackfillSlice }));

import { waitUntil } from "@vercel/functions";
import { action } from "../api.github.backfill-run";

const SECRET = "shhh";
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://doco.to/api/github/backfill-run", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  process.env.DOCO_GITHUB_WEBHOOK_SECRET = undefined;
  getDocoConnectionsContext.mockReset();
  runBackfillSlice.mockReset();
  (waitUntil as unknown as ReturnType<typeof vi.fn>).mockReset();
  global.fetch = vi.fn(async () => new Response("{}")) as never;
});
afterEach(() => {
  process.env.CRON_SECRET = undefined;
});

describe("api.github.backfill-run action", () => {
  it("403s without the bearer secret or cron header", async () => {
    const res = await action({ request: post({ docoId: "doco_1" }) });
    expect(res.status).toBe(403);
    expect(getDocoConnectionsContext).not.toHaveBeenCalled();
  });

  it("400s when docoId is missing", async () => {
    const res = await action({ request: post({}, { Authorization: `Bearer ${SECRET}` }) });
    expect(res.status).toBe(400);
  });

  it("skips (no re-import) when the marker is already done", async () => {
    getDocoConnectionsContext.mockResolvedValue({
      handle: "d",
      workspaceHandle: "o",
      connections: [],
      backfill: { status: "done", queue: ["acme/a"] },
    });
    const res = await action({
      request: post({ docoId: "doco_1" }, { Authorization: `Bearer ${SECRET}` }),
    });
    expect(await res.json()).toEqual({ done: true, skipped: true });
    expect(runBackfillSlice).not.toHaveBeenCalled();
  });

  it("rebuilds the queue from connections for a stranded running marker (no queue)", async () => {
    // A marker written before the resumable driver shipped: running, no cursor.
    getDocoConnectionsContext.mockResolvedValue({
      handle: "d",
      workspaceHandle: "o",
      connections: [
        { repo: "acme/a", installation_id: 7 },
        { repo: "acme/b", installation_id: 7 },
      ],
      backfill: { status: "running", repos: 2 },
    });
    runBackfillSlice.mockResolvedValue({ done: false });

    const res = await action({
      request: post({ docoId: "doco_1" }, { Authorization: `Bearer ${SECRET}` }),
    });

    expect(await res.json()).toEqual({ done: false });
    expect(resumeCursorFromConnections).toHaveBeenCalled();
    // The reconstructed cursor (with a queue) is what the slice walks.
    expect(runBackfillSlice).toHaveBeenCalledWith(
      expect.objectContaining({ queue: ["acme/a", "acme/b"] }),
      expect.objectContaining({ docoId: "doco_1" }),
    );
  });

  it("skips a running marker with no queue AND no connections (nothing to do)", async () => {
    getDocoConnectionsContext.mockResolvedValue({
      handle: "d",
      workspaceHandle: "o",
      connections: [],
      backfill: { status: "running" },
    });
    const res = await action({
      request: post({ docoId: "doco_1" }, { Authorization: `Bearer ${SECRET}` }),
    });
    expect(await res.json()).toEqual({ done: true, skipped: true });
    expect(runBackfillSlice).not.toHaveBeenCalled();
  });

  it("runs a slice and does NOT re-kick when the slice finishes", async () => {
    getDocoConnectionsContext.mockResolvedValue({
      handle: "d",
      workspaceHandle: "o",
      template: "github-issues",
      connections: [{ repo: "acme/a", installation_id: 42 }],
      backfill: { status: "running", queue: ["acme/a"], page: 1 },
    });
    runBackfillSlice.mockResolvedValue({ done: true });

    const res = await action({
      request: post({ docoId: "doco_1" }, { Authorization: `Bearer ${SECRET}` }),
    });

    expect(await res.json()).toEqual({ done: true });
    expect(runBackfillSlice).toHaveBeenCalledWith(
      expect.objectContaining({ status: "running" }),
      expect.objectContaining({
        docoId: "doco_1",
        docoDir: "/repos/d",
        ownerSlug: "o",
        docoSlug: "d",
        // The slice walks what the Doco brings: issues, for a GitHub issues Doco.
        template: "github-issues",
        // Each queued repository imports through the installation its connection names.
        installationByRepo: { "acme/a": 42 },
      }),
    );
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("re-kicks itself when the slice is not done", async () => {
    getDocoConnectionsContext.mockResolvedValue({
      handle: "d",
      workspaceHandle: "o",
      connections: [],
      backfill: { status: "running", queue: ["acme/a", "acme/b"], page: 1 },
    });
    runBackfillSlice.mockResolvedValue({ done: false });

    const res = await action({
      request: post({ docoId: "doco_1" }, { Authorization: `Bearer ${SECRET}` }),
    });

    expect(await res.json()).toEqual({ done: false });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    // The self-kick targets the same origin's worker with the bearer secret.
    expect(global.fetch).toHaveBeenCalledWith(
      "https://doco.to/api/github/backfill-run",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: `Bearer ${SECRET}` }),
      }),
    );
  });

  it("rejects a request carrying only the x-vercel-cron header (any client can set it)", async () => {
    const res = await action({
      request: post({ docoId: "doco_1" }, { "x-vercel-cron": "1" }),
    });
    expect(res.status).toBe(403);
    expect(getDocoConnectionsContext).not.toHaveBeenCalled();
  });

  it("does NOT immediately re-kick when the slice paused for a rate limit", async () => {
    // An immediate re-kick would just re-hit the same rate limit. The marker's
    // retry_after + the sweep resume it once GitHub's window clears.
    getDocoConnectionsContext.mockResolvedValue({
      handle: "d",
      workspaceHandle: "o",
      connections: [],
      backfill: { status: "running", queue: ["acme/a", "acme/b"], page: 1 },
    });
    runBackfillSlice.mockResolvedValue({ done: false, rateLimited: true });

    const res = await action({
      request: post({ docoId: "doco_1" }, { Authorization: `Bearer ${SECRET}` }),
    });

    expect(await res.json()).toMatchObject({ done: false, rateLimited: true });
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("skips running a slice while a rate-limit retry_after is still in the future", async () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    getDocoConnectionsContext.mockResolvedValue({
      handle: "d",
      workspaceHandle: "o",
      connections: [{ repo: "acme/a", installation_id: 7 }],
      backfill: {
        status: "running",
        queue: ["acme/a"],
        page: 1,
        retry_after: future,
      },
    });

    const res = await action({
      request: post({ docoId: "doco_1" }, { Authorization: `Bearer ${SECRET}` }),
    });

    expect(await res.json()).toMatchObject({ done: false, waiting: true });
    expect(runBackfillSlice).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it("returns 200 (not a 500) and drops the chain to the sweep if a slice throws", async () => {
    getDocoConnectionsContext.mockResolvedValue({
      handle: "d",
      workspaceHandle: "o",
      connections: [],
      backfill: { status: "running", queue: ["acme/a"], page: 1 },
    });
    runBackfillSlice.mockRejectedValue(new Error("unexpected blowup"));

    const res = await action({
      request: post({ docoId: "doco_1" }, { Authorization: `Bearer ${SECRET}` }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ done: false });
    expect(waitUntil).not.toHaveBeenCalled();
  });
});
