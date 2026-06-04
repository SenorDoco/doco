import { describe, expect, it } from "vitest";
import { BPMN_LOD_ZOOM, bpmnSimplifiedAtZoom } from "~/lib/bpmn-lod";

describe("bpmnSimplifiedAtZoom", () => {
  it("renders full detail at normal reading zoom", () => {
    // At zoom 1 (and above) every shape shows its label, badges, and
    // shadow — the threshold must never trip at reading zoom.
    expect(bpmnSimplifiedAtZoom(1)).toBe(false);
    expect(bpmnSimplifiedAtZoom(2)).toBe(false);
  });

  it("simplifies once zoomed out far enough that labels are illegible", () => {
    // With a 10px base label, zoom 0.3 paints ~3px text — illegible, so
    // we drop the per-node label/badge/shadow paint that makes a
    // many-node pan draggy.
    expect(bpmnSimplifiedAtZoom(0.3)).toBe(true);
    expect(bpmnSimplifiedAtZoom(0.1)).toBe(true);
  });

  it("crosses exactly at the published threshold", () => {
    // The boolean must flip at BPMN_LOD_ZOOM and nowhere else, so node
    // components (which select on this boolean) re-render at most once
    // across a zoom gesture rather than on every frame.
    expect(bpmnSimplifiedAtZoom(BPMN_LOD_ZOOM)).toBe(false);
    expect(bpmnSimplifiedAtZoom(BPMN_LOD_ZOOM - 0.0001)).toBe(true);
  });
});
