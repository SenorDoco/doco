export interface OverviewNodeLabelSource {
  id: string;
  node_type: string;
  name: string | null;
}

export interface OverviewNodeDetailLabelSource {
  name: string | null;
  summary: string | null;
}

export function overviewNodeDisplayLabel(
  node: OverviewNodeLabelSource,
  detail?: OverviewNodeDetailLabelSource | null,
): string {
  return node.name ?? detail?.summary ?? detail?.name ?? node.id;
}
