// The masthead of a workspace's newspaper, The <Workspace> Times
// (lib/activity-digest.ts): its title set in Chomsky, the blackletter Doco's
// logo is set in, as a PNG. Mail clients won't load a web font (Gmail,
// Outlook) and many won't show an SVG, so the title is drawn here: opentype.js
// lays it out from the font's outlines with its kerning, a scanline
// rasterizer fills them with exact-area anti-aliasing (font-rs's), and
// node:zlib packs the pixels into a PNG. Nothing native, so nothing the
// deployment can drop.
//
// Chomsky (fonts/chomsky.ts) is Fredrick R. Brennan's free blackletter after
// the New York Times nameplate, under the SIL Open Font License 1.1.
//
// /masthead.png?t=<token> serves it. The token is the title sealed with
// secret-box under a "masthead" tag, so only Doco chooses what is drawn and
// no other sealed value is ever drawn; the image never changes, so caches
// keep it, and an email keeps the name its workspace had when it went out.

import { crc32, deflateSync } from "node:zlib";
import { type PathCommand, parse } from "opentype.js";
import { CHOMSKY_OTF_BASE64 } from "~/fonts/chomsky";
import { decryptSecret, encryptSecret } from "./secret-box.server";

/** How wide the masthead is drawn: twice the 544px an email shows it at. */
export const MASTHEAD_WIDTH = 1088;
/** The largest the title is set; a longer one is set smaller to fit. */
const FONT_SIZE = 136;
const PADDING = 16;
const INK = [0x17, 0x16, 0x12]; // --color-foreground
const PAPER = [0xf3, 0xf2, 0xee]; // --color-background

let chomsky: ReturnType<typeof parse> | undefined;
function font() {
  if (!chomsky) {
    const bytes = Buffer.from(CHOMSKY_OTF_BASE64, "base64");
    chomsky = parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  return chomsky;
}

type Point = [number, number];

/** How much of each pixel the closed outlines cover, from 0 to 1, by the
 *  nonzero rule: each edge adds its signed area to the cells it crosses, and a
 *  running sum along the rows turns that into coverage. */
function rasterize(
  commands: PathCommand[],
  width: number,
  height: number,
  at: (x: number, y: number) => Point,
): Float32Array {
  // Two spare cells for an edge that ends on the last column.
  const cells = new Float32Array(width * height + 2);
  const line = ([ax, ay]: Point, [bx, by]: Point) => {
    if (ay === by) return;
    const [dir, x0, y0, x1, y1] = ay < by ? [1, ax, ay, bx, by] : [-1, bx, by, ax, ay];
    const dxdy = (x1 - x0) / (y1 - y0);
    let x = x0 + Math.max(0, -y0) * dxdy;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y++) {
      const row = y * width;
      const dy = Math.min(y + 1, y1) - Math.max(y, y0);
      const next = x + dxdy * dy;
      const d = dy * dir;
      const [left, right] = x < next ? [x, next] : [next, x];
      const l = Math.floor(left);
      const r = Math.ceil(right);
      if (r <= l + 1) {
        const mid = 0.5 * (x + next) - l;
        cells[row + l] += d - d * mid;
        cells[row + l + 1] += d * mid;
      } else {
        const s = 1 / (right - left);
        const lf = left - l;
        const a0 = 0.5 * s * (1 - lf) ** 2;
        const rf = right - r + 1;
        const am = 0.5 * s * rf * rf;
        cells[row + l] += d * a0;
        if (r === l + 2) cells[row + l + 1] += d * (1 - a0 - am);
        else {
          const a1 = s * (1.5 - lf);
          cells[row + l + 1] += d * (a1 - a0);
          for (let i = l + 2; i < r - 1; i++) cells[row + i] += d * s;
          cells[row + r - 1] += d * (1 - a1 - (r - l - 3) * s - am);
        }
        cells[row + r] += d * am;
      }
      x = next;
    }
  };
  // Curves become lines about two pixels long.
  const curve = (points: Point[]) => {
    let length = 0;
    for (let i = 1; i < points.length; i++) {
      length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    const steps = Math.min(64, Math.max(1, Math.ceil(length / 2)));
    let from = points[0];
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const w =
        points.length === 3
          ? [u * u, 2 * u * t, t * t]
          : [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
      const to: Point = [0, 1].map((k) =>
        w.reduce((sum, wi, j) => sum + wi * points[j][k], 0),
      ) as Point;
      line(from, to);
      from = to;
    }
  };
  let start: Point = [0, 0];
  let pen: Point = [0, 0];
  for (const c of commands) {
    if (c.type === "M") {
      line(pen, start);
      start = pen = at(c.x, c.y);
    } else if (c.type === "L") {
      const to = at(c.x, c.y);
      line(pen, to);
      pen = to;
    } else if (c.type === "Q") {
      const to = at(c.x, c.y);
      curve([pen, at(c.x1, c.y1), to]);
      pen = to;
    } else if (c.type === "C") {
      const to = at(c.x, c.y);
      curve([pen, at(c.x1, c.y1), at(c.x2, c.y2), to]);
      pen = to;
    } else {
      line(pen, start);
      pen = start;
    }
  }
  line(pen, start);
  let sum = 0;
  for (let i = 0; i < width * height; i++) {
    sum += cells[i];
    cells[i] = Math.min(1, Math.abs(sum));
  }
  return cells;
}

/** An 8-bit RGB PNG of ink over paper, as much ink in each pixel as `coverage` says. */
function png(width: number, height: number, coverage: Float32Array): Buffer {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = coverage[y * width + x];
      for (let k = 0; k < 3; k++) {
        raw[y * stride + 1 + x * 3 + k] = Math.round(PAPER[k] + (INK[k] - PAPER[k]) * a);
      }
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bits per channel
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The title in Chomsky, centered on the paper, MASTHEAD_WIDTH wide and as
 *  tall as its letters reach. */
export function mastheadPng(title: string): Buffer {
  const path = font().getPath(title, 0, 0, FONT_SIZE, { kerning: true });
  const box = path.getBoundingBox();
  const scale = Math.min(1, (MASTHEAD_WIDTH - 2 * PADDING) / (box.x2 - box.x1));
  const left = (MASTHEAD_WIDTH - (box.x2 - box.x1) * scale) / 2;
  const height = Math.ceil((box.y2 - box.y1) * scale) + 2 * PADDING;
  const at = (x: number, y: number): Point => [
    left + (x - box.x1) * scale,
    PADDING + (y - box.y1) * scale,
  ];
  return png(MASTHEAD_WIDTH, height, rasterize(path.commands, MASTHEAD_WIDTH, height, at));
}

const TAG = "masthead";

/** Where an email finds the masthead of `title`. */
export function mastheadUrl(baseUrl: string, title: string): string {
  const t = new URLSearchParams({ t: encryptSecret(JSON.stringify([TAG, title])) });
  return `${baseUrl.replace(/\/+$/, "")}/masthead.png?${t}`;
}

/** The title a masthead token seals, or null for anything else. */
export function readMastheadToken(token: string): string | null {
  try {
    const [tag, title] = JSON.parse(decryptSecret(token)) as unknown[];
    return tag === TAG && typeof title === "string" ? title : null;
  } catch {
    return null;
  }
}
