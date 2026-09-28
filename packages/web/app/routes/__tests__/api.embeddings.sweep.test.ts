import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDocoEmbeddingProvider: vi.fn(),
  sweepEmbeddings: vi.fn(),
}));

vi.mock("~/lib/embedding-provider.server", () => ({
  getDocoEmbeddingProvider: mocks.getDocoEmbeddingProvider,
}));
vi.mock("~/lib/embedding-sweep.server", () => ({ sweepEmbeddings: mocks.sweepEmbeddings }));

import { loader } from "../api.embeddings.sweep";

function call(headers: Record<string, string> = {}) {
  return loader({ request: new Request("https://doco.test/api/embeddings/sweep", { headers }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", "cron-secret");
  mocks.sweepEmbeddings.mockResolvedValue({ nodes: 2, batches: 1, exhausted: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/embeddings/sweep", () => {
  it("only answers Vercel Cron's bearer", async () => {
    expect((await call()).status).toBe(403);
    expect((await call({ "x-vercel-cron": "1" })).status).toBe(403);
    expect((await call({ authorization: "Bearer wrong" })).status).toBe(403);
    expect(mocks.sweepEmbeddings).not.toHaveBeenCalled();
  });

  it("does nothing without an embedding provider", async () => {
    mocks.getDocoEmbeddingProvider.mockReturnValue(undefined);
    const res = await call({ authorization: "Bearer cron-secret" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, skipped: "no_provider" });
    expect(mocks.sweepEmbeddings).not.toHaveBeenCalled();
  });

  it("runs one pass with the configured provider", async () => {
    const provider = { modelId: "test:model", dimensions: 3, embed: vi.fn() };
    mocks.getDocoEmbeddingProvider.mockReturnValue(provider);
    const res = await call({ authorization: "Bearer cron-secret" });
    expect(await res.json()).toEqual({ ok: true, nodes: 2, batches: 1, exhausted: true });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.sweepEmbeddings).toHaveBeenCalledWith({ provider });
  });
});
