import { useEffect, useState } from "react";

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) {
    if (!b.has(id)) return false;
  }
  return true;
}

function filteredSet(ids: ReadonlySet<string>, renderableIds: ReadonlySet<string>): Set<string> {
  const next = new Set<string>();
  for (const id of ids) {
    if (renderableIds.has(id)) next.add(id);
  }
  return next;
}

export function useBufferedRenderedIds(
  targetIds: ReadonlySet<string>,
  renderableIds: ReadonlySet<string>,
): Set<string> {
  const [renderedIds, setRenderedIds] = useState<Set<string>>(() =>
    filteredSet(targetIds, renderableIds),
  );

  useEffect(() => {
    const target = filteredSet(targetIds, renderableIds);
    setRenderedIds((previous) => {
      const next = new Set(target);
      for (const id of previous) {
        if (renderableIds.has(id)) next.add(id);
      }
      return sameSet(previous, next) ? previous : next;
    });

    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        setRenderedIds((previous) => (sameSet(previous, target) ? previous : target));
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame) window.cancelAnimationFrame(secondFrame);
    };
  }, [targetIds, renderableIds]);

  return renderedIds;
}
