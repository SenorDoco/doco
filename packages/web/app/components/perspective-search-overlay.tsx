import { SearchBoxWithHistory } from "~/components/search-box-with-history";

// Floating node-search box that overlays the active perspective. It's
// absolutely positioned over the top-right of the canvas so it doesn't push
// the canvas down or compete with the tab strip for row space. One overlay
// serves every perspective (List, Graph, BPMN, Org Tree, …) because it lives
// in the shared perspective host, not inside any single perspective.
//
// `z-[60]` is load-bearing: `PerspectiveFrame` is an opaque `bg-card` sibling
// painted after this overlay at `z-50`, so any lower z lets the canvas paint
// straight over the search and hide it on every perspective. It stays below
// the perspective-tab settings dropdown (`z-[70]`) and the page detail dialog
// (`z-[100]`). `perspective-search-overlay.test.tsx` locks the frame ordering.
export function PerspectiveSearchOverlay({
  handle,
  totalNodes,
}: {
  handle: string;
  totalNodes: number;
}) {
  return (
    <div className="pointer-events-none absolute right-3 top-3 z-[60] w-64 max-w-[calc(100%-2rem)]">
      <div className="pointer-events-auto">
        <SearchBoxWithHistory
          handle={handle}
          placeholder={
            totalNodes > 0
              ? `Search ${totalNodes} node${totalNodes === 1 ? "" : "s"}…`
              : "Search nodes…"
          }
          compact
        />
      </div>
    </div>
  );
}
