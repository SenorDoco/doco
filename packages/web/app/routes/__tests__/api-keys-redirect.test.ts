import { describe, expect, it } from "vitest";
import { action, loader } from "../api-keys";

// The Tokens/MCP page moved to /tokens; /api-keys is now a permanent shim that
// 302-redirects there so old bookmarks, the historical OAuth-recipe URL, and
// any stale links keep working. The query string rides along.
async function locationOf(run: () => unknown): Promise<{ status: number; location: string }> {
  try {
    await run();
  } catch (thrown) {
    if (thrown instanceof Response) {
      return { status: thrown.status, location: thrown.headers.get("Location") ?? "" };
    }
    throw thrown;
  }
  throw new Error("expected a redirect Response to be thrown");
}

describe("/api-keys (legacy redirect to /tokens)", () => {
  it("redirects GET to /tokens", async () => {
    const { status, location } = await locationOf(() =>
      loader({ request: new Request("https://doco.test/api-keys") }),
    );
    expect(status).toBe(302);
    expect(location).toBe("/tokens");
  });

  it("preserves the query string", async () => {
    const { location } = await locationOf(() =>
      loader({ request: new Request("https://doco.test/api-keys?tab=mcp&foo=1") }),
    );
    expect(location).toBe("/tokens?tab=mcp&foo=1");
  });

  it("redirects POST to /tokens too", async () => {
    const { status, location } = await locationOf(() =>
      action({ request: new Request("https://doco.test/api-keys", { method: "POST" }) }),
    );
    expect(status).toBe(302);
    expect(location).toBe("/tokens");
  });
});
