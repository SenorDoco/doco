// Level-of-detail (LOD) for the BPMN canvas.
//
// The perspective renders every shape as a DOM node — a bordered box with
// a 10px label, a row of type/lifecycle badges, and a drop shadow. When
// you zoom out to see many nodes at once, that per-node label/badge/shadow
// paint is what makes a pan draggy: the browser re-composites every shadow
// and re-lays-out every label on each frame, even though the text is far
// too small to read.
//
// Below BPMN_LOD_ZOOM we drop those details and render just the colored
// shape. Nothing meaningful is lost at that zoom — the shape still encodes
// the node type and the stroke color still encodes lifecycle — but the
// frame cost collapses to a plain bordered box per node, which pans
// smoothly.
//
// The threshold is a single hard cutoff (no hysteresis) on purpose: node
// components select on the *boolean* this produces, so they re-render at
// most once as a zoom gesture crosses the line, never per frame.
export const BPMN_LOD_ZOOM = 0.5;

/**
 * Whether the BPMN canvas should render simplified (shape-only) nodes at
 * the given React Flow zoom level. `zoom` is `transform[2]` from the flow
 * store — 1 is 1:1, 2 is the max, 0.1 the min.
 */
export function bpmnSimplifiedAtZoom(zoom: number): boolean {
  return zoom < BPMN_LOD_ZOOM;
}
