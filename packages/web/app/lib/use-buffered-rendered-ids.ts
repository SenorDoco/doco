import { useEffect, useMemo, useState } from "react";

export interface BufferedRenderedIds {
  renderedIds: Set<string>;
  opacityById: Map<string, number>;
}

const RENDER_WINDOW_FADE_MS = 500;

function filteredSet(ids: ReadonlySet<string>, renderableIds: ReadonlySet<string>): Set<string> {
  const next = new Set<string>();
  for (const id of ids) {
    if (renderableIds.has(id)) next.add(id);
  }
  return next;
}

function sameOpacityMap(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, opacity] of a) {
    if (b.get(id) !== opacity) return false;
  }
  return true;
}

function idsFromOpacityMap(opacityById: ReadonlyMap<string, number>): Set<string> {
  return new Set(opacityById.keys());
}

export function useBufferedRenderedIds(
  targetIds: ReadonlySet<string>,
  renderableIds: ReadonlySet<string>,
): BufferedRenderedIds {
  const [opacityById, setOpacityById] = useState<Map<string, number>>(
    () => new Map(Array.from(filteredSet(targetIds, renderableIds), (id) => [id, 1])),
  );

  useEffect(() => {
    const target = filteredSet(targetIds, renderableIds);
    setOpacityById((previous) => {
      const next = new Map<string, number>();
      for (const id of target) {
        next.set(id, previous.has(id) ? 1 : 0);
      }
      for (const id of previous.keys()) {
        if (!target.has(id) && renderableIds.has(id)) next.set(id, 0);
      }
      return sameOpacityMap(previous, next) ? previous : next;
    });

    const firstFrame = window.requestAnimationFrame(() => {
      setOpacityById((previous) => {
        const next = new Map<string, number>();
        for (const [id, opacity] of previous) {
          if (target.has(id)) next.set(id, 1);
          else next.set(id, opacity);
        }
        return sameOpacityMap(previous, next) ? previous : next;
      });
    });
    const cleanup = window.setTimeout(() => {
      setOpacityById((previous) => {
        const next = new Map<string, number>();
        for (const id of target) next.set(id, 1);
        return sameOpacityMap(previous, next) ? previous : next;
      });
    }, RENDER_WINDOW_FADE_MS);

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.clearTimeout(cleanup);
    };
  }, [targetIds, renderableIds]);

  return useMemo(
    () => ({
      renderedIds: idsFromOpacityMap(opacityById),
      opacityById,
    }),
    [opacityById],
  );
}
