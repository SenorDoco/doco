// The masthead of a workspace's newspaper, The <Workspace> Times: its title
// set in Chomsky and drawn as a PNG, since mail clients won't load a web font,
// at a URL that carries the title sealed so only Doco chooses what is drawn.
import { randomBytes } from "node:crypto";
import { inflateSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MASTHEAD_WIDTH, mastheadPng, mastheadUrl, readMastheadToken } from "../masthead.server";
import { encryptSecret } from "../secret-box.server";

/** The PNG's size and its pixels as [r, g, b], row by row. */
function decode(png: Buffer): {
  width: number;
  height: number;
  pixel: (x: number, y: number) => number[];
} {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      // 8-bit RGB, no interlacing.
      expect([...body.subarray(8)]).toEqual([8, 2, 0, 0, 0]);
    }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * 3 + 1;
  expect(raw.length).toBe(stride * height);
  // Every row is stored unfiltered.
  for (let y = 0; y < height; y++) expect(raw[y * stride]).toBe(0);
  return {
    width,
    height,
    pixel: (x, y) => {
      const at = y * stride + 1 + x * 3;
      return [raw[at], raw[at + 1], raw[at + 2]];
    },
  };
}

const PAPER = [0xf3, 0xf2, 0xee];
const INK = [0x17, 0x16, 0x12];

/** How many pixels of a column are inked. */
function inked(image: ReturnType<typeof decode>, x: number): number {
  let n = 0;
  for (let y = 0; y < image.height; y++) if (image.pixel(x, y)[0] < 0x80) n++;
  return n;
}

describe("mastheadPng", () => {
  it("sets the title in ink on the page's paper, centered, at twice its email width", () => {
    const image = decode(mastheadPng("The Acme Times"));
    expect(image.width).toBe(MASTHEAD_WIDTH);
    expect(image.height).toBeGreaterThan(80);
    expect(image.height).toBeLessThan(200);
    expect(image.pixel(0, 0)).toEqual(PAPER);
    expect(image.pixel(MASTHEAD_WIDTH - 1, image.height - 1)).toEqual(PAPER);
    const columns = Array.from({ length: MASTHEAD_WIDTH }, (_, x) => inked(image, x));
    const first = columns.findIndex((n) => n > 0);
    const last = MASTHEAD_WIDTH - 1 - [...columns].reverse().findIndex((n) => n > 0);
    // Centered, with paper on both sides.
    expect(first).toBeGreaterThan(100);
    expect(Math.abs(first - (MASTHEAD_WIDTH - 1 - last))).toBeLessThanOrEqual(2);
    // Solid strokes in full ink, and anti-aliased edges in between.
    const all = Array.from({ length: image.height }, (_, y) =>
      columns.map((_, x) => image.pixel(x, y)[0]),
    ).flat();
    expect(all).toContain(INK[0]);
    expect(all.some((r) => r > INK[0] + 20 && r < PAPER[0] - 20)).toBe(true);
  });

  it("sets a long title smaller so it fits", () => {
    const image = decode(
      mastheadPng("The Torre Labs Research and Development Division of the Future Times"),
    );
    expect(image.width).toBe(MASTHEAD_WIDTH);
    expect(inked(image, 0)).toBe(0);
    expect(inked(image, MASTHEAD_WIDTH - 1)).toBe(0);
    expect(inked(image, 40)).toBeGreaterThan(0);
  });
});

describe("mastheadUrl", () => {
  beforeEach(() => {
    vi.stubEnv("DOCO_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
  });

  it("carries the title sealed, for /masthead.png to draw", () => {
    const url = new URL(mastheadUrl("https://doco.test/", "The Acme Times"));
    expect(url.origin + url.pathname).toBe("https://doco.test/masthead.png");
    expect(url.search).not.toContain("Acme");
    expect(readMastheadToken(url.searchParams.get("t") ?? "")).toBe("The Acme Times");
  });

  it("draws nothing it didn't seal as a masthead", () => {
    expect(readMastheadToken("The Acme Times")).toBeNull();
    expect(readMastheadToken("v1:tampered.with.this")).toBeNull();
    // Another sealed value, such as a stored credential or a digest link's
    // member, is never drawn.
    expect(readMastheadToken(encryptSecret("xoxb-slack-token"))).toBeNull();
    expect(
      readMastheadToken(encryptSecret(JSON.stringify(["workspace_acme", "user_ana"]))),
    ).toBeNull();
  });
});
