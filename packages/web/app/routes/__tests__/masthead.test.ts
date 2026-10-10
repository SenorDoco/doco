// /masthead.png draws the masthead a token seals, and nothing else; the image
// never changes for a token, so caches keep it.
import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mastheadUrl } from "~/lib/masthead.server";
import { loader } from "~/routes/masthead[.]png";

describe("/masthead.png", () => {
  beforeEach(() => {
    vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  });

  it("draws the sealed title as a PNG that caches keep for a year", async () => {
    const res = await loader({
      request: new Request(mastheadUrl("https://doco.test", "The Acme Times")),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, s-maxage=31536000, immutable",
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(1, 4).toString("ascii")).toBe("PNG");
  });

  it("draws nothing for a token it didn't seal", async () => {
    const res = await loader({
      request: new Request("https://doco.test/masthead.png?t=The+Acme+Times"),
    });
    expect(res.status).toBe(404);
  });
});
