import { describe, expect, it } from "vitest";
import { PROCESS_LOD_ZOOM, processSimplifiedAtZoom } from "~/lib/process-lod";

describe("processSimplifiedAtZoom", () => {
  it("renders full detail at normal reading zoom", () => {
    // At zoom 1 (and above) every shape shows its label, badges, and
    // shadow — the threshold must never trip at reading zoom.
    expect(processSimplifiedAtZoom(1)).toBe(false);
    expect(processSimplifiedAtZoom(2)).toBe(false);
  });

  it("simplifies once zoomed out far enough that labels are illegible", () => {
    // With a 10px base label, zoom 0.3 paints ~3px text — illegible, so
    // we drop the per-node label/badge/shadow paint that makes a
    // many-node pan draggy.
    expect(processSimplifiedAtZoom(0.3)).toBe(true);
    expect(processSimplifiedAtZoom(0.1)).toBe(true);
  });

  it("crosses exactly at the published threshold", () => {
    // The boolean must flip at PROCESS_LOD_ZOOM and nowhere else, so node
    // components (which select on this boolean) re-render at most once
    // across a zoom gesture rather than on every frame.
    expect(processSimplifiedAtZoom(PROCESS_LOD_ZOOM)).toBe(false);
    expect(processSimplifiedAtZoom(PROCESS_LOD_ZOOM - 0.0001)).toBe(true);
  });
});
