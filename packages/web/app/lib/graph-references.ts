export interface GraphReferenceItem {
  number: number;
  id: string;
  entity_type: string;
  label: string;
  lifecycle: string | null;
  href?: string | null;
}

export interface GraphReferenceGroup {
  graphId: string;
  source: string;
  references: GraphReferenceItem[];
}

declare global {
  interface Window {
    __docoGraphReferences?: Record<string, GraphReferenceGroup>;
  }
}

const GRAPH_REFERENCES_CHANGE_EVENT = "doco:graph-references-change";

export function publishGraphReferences(
  graphId: string,
  source: string,
  references: GraphReferenceItem[],
): void {
  if (typeof window === "undefined") return;
  let store = window.__docoGraphReferences;
  if (!store) {
    store = {};
    window.__docoGraphReferences = store;
  }
  if (references.length > 0) {
    store[graphId] = { graphId, source, references };
  } else {
    delete store[graphId];
  }
  window.dispatchEvent(new CustomEvent(GRAPH_REFERENCES_CHANGE_EVENT));
}

export function clearGraphReferences(graphId: string): void {
  if (typeof window === "undefined") return;
  const store = window.__docoGraphReferences;
  if (!store || !(graphId in store)) return;
  delete store[graphId];
  window.dispatchEvent(new CustomEvent(GRAPH_REFERENCES_CHANGE_EVENT));
}

export function readGraphReferenceGroups(): GraphReferenceGroup[] {
  if (typeof window === "undefined") return [];
  const published = Object.values(window.__docoGraphReferences ?? {}).filter(
    (group) => group.references.length > 0,
  );
  if (published.length > 0) return published;

  const references = Array.from(
    window.document.querySelectorAll<HTMLElement>("[data-graph-reference-number][data-node-id]"),
  )
    .flatMap((element) => {
      const number = Number(element.dataset.graphReferenceNumber);
      const id = element.dataset.nodeId ?? "";
      const entityType = element.dataset.nodeType ?? "";
      if (!Number.isInteger(number) || number < 1 || !id || !entityType) return [];
      return [
        {
          number,
          id,
          entity_type: entityType,
          label: element.dataset.nodeLabel ?? element.textContent?.trim() ?? id,
          lifecycle: element.dataset.nodeLifecycle ?? null,
          href: element.dataset.nodeHref ?? null,
        },
      ];
    })
    .sort((a, b) => a.number - b.number);
  return references.length > 0 ? [{ graphId: "visible-dom", source: "visible", references }] : [];
}
