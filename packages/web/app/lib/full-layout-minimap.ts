import {
  type CanvasRect,
  type FlowViewport,
  type ViewportSize,
  rectForViewport,
} from "./viewport-render-window";

export type FullLayoutMiniMapKind = "node" | "lane" | "pool";

export type FullLayoutMiniMapShape = "rect" | "rounded" | "circle" | "diamond" | "document";

export interface FullLayoutMiniMapItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  kind?: FullLayoutMiniMapKind;
  shape?: FullLayoutMiniMapShape;
  opacity?: number;
}

export interface FullLayoutMiniMapPanel {
  width: number;
  height: number;
  padding?: number;
}

export interface FullLayoutMiniMapRect extends FullLayoutMiniMapItem {
  mapX: number;
  mapY: number;
  mapWidth: number;
  mapHeight: number;
}

export interface FullLayoutMiniMapBase {
  width: number;
  height: number;
  padding: number;
  bounds: CanvasRect;
  scale: number;
  originX: number;
  originY: number;
  rects: FullLayoutMiniMapRect[];
}

export interface MiniMapScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_PADDING = 8;
const MIN_WORLD_SIZE = 1;

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function boundsForItems(items: readonly FullLayoutMiniMapItem[]): CanvasRect | null {
  if (items.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const item of items) {
    const x = finiteOr(item.x, 0);
    const y = finiteOr(item.y, 0);
    const width = Math.max(1, finiteOr(item.width, 1));
    const height = Math.max(1, finiteOr(item.height, 1));
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + width);
    maxY = Math.max(maxY, y + height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const width = Math.max(MIN_WORLD_SIZE, maxX - minX);
  const height = Math.max(MIN_WORLD_SIZE, maxY - minY);
  const worldPad = Math.max(40, Math.min(500, Math.max(width, height) * 0.03));
  return {
    minX: minX - worldPad,
    minY: minY - worldPad,
    maxX: maxX + worldPad,
    maxY: maxY + worldPad,
  };
}

export function mapCanvasRect(
  base: Pick<FullLayoutMiniMapBase, "bounds" | "scale" | "originX" | "originY">,
  rect: CanvasRect,
): MiniMapScreenRect {
  return {
    x: base.originX + (rect.minX - base.bounds.minX) * base.scale,
    y: base.originY + (rect.minY - base.bounds.minY) * base.scale,
    width: Math.max(0, (rect.maxX - rect.minX) * base.scale),
    height: Math.max(0, (rect.maxY - rect.minY) * base.scale),
  };
}

export function computeFullLayoutMiniMapBase(
  items: readonly FullLayoutMiniMapItem[],
  panel: FullLayoutMiniMapPanel,
): FullLayoutMiniMapBase | null {
  const bounds = boundsForItems(items);
  if (!bounds) return null;

  const width = Math.max(1, finiteOr(panel.width, 1));
  const height = Math.max(1, finiteOr(panel.height, 1));
  const padding = Math.max(0, finiteOr(panel.padding ?? DEFAULT_PADDING, DEFAULT_PADDING));
  const drawableWidth = Math.max(1, width - padding * 2);
  const drawableHeight = Math.max(1, height - padding * 2);
  const worldWidth = Math.max(MIN_WORLD_SIZE, bounds.maxX - bounds.minX);
  const worldHeight = Math.max(MIN_WORLD_SIZE, bounds.maxY - bounds.minY);
  const scale = Math.min(drawableWidth / worldWidth, drawableHeight / worldHeight);
  const mapWidth = worldWidth * scale;
  const mapHeight = worldHeight * scale;
  const originX = padding + (drawableWidth - mapWidth) / 2;
  const originY = padding + (drawableHeight - mapHeight) / 2;

  const rects = items.map((item) => {
    const mapped = mapCanvasRect(
      { bounds, scale, originX, originY },
      {
        minX: item.x,
        minY: item.y,
        maxX: item.x + Math.max(1, item.width),
        maxY: item.y + Math.max(1, item.height),
      },
    );
    return {
      ...item,
      mapX: mapped.x,
      mapY: mapped.y,
      mapWidth: mapped.width,
      mapHeight: mapped.height,
    };
  });

  return { width, height, padding, bounds, scale, originX, originY, rects };
}

export function computeFullLayoutMiniMapViewportRect(
  base: Pick<FullLayoutMiniMapBase, "bounds" | "scale" | "originX" | "originY">,
  viewport: FlowViewport,
  size: ViewportSize,
): MiniMapScreenRect {
  return mapCanvasRect(base, rectForViewport(viewport, size, 0));
}

export function pointForMiniMapPosition(
  base: Pick<FullLayoutMiniMapBase, "bounds" | "scale" | "originX" | "originY">,
  x: number,
  y: number,
): { x: number; y: number } {
  return {
    x: (x - base.originX) / Math.max(0.0001, base.scale) + base.bounds.minX,
    y: (y - base.originY) / Math.max(0.0001, base.scale) + base.bounds.minY,
  };
}
