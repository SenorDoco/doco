import { type PointerEvent, useCallback, useEffect, useMemo, useRef } from "react";
import { cn } from "~/lib/cn";
import {
  type FullLayoutMiniMapBase,
  type FullLayoutMiniMapItem,
  computeFullLayoutMiniMapBase,
  computeFullLayoutMiniMapViewportRect,
  pointForMiniMapPosition,
} from "~/lib/full-layout-minimap";
import type { FlowViewport, ViewportSize } from "~/lib/viewport-render-window";

const MINI_MAP_WIDTH = 140;
const MINI_MAP_HEIGHT = 100;
const MINI_MAP_PANEL = { width: MINI_MAP_WIDTH, height: MINI_MAP_HEIGHT, padding: 8 };

interface FullLayoutMiniMapProps {
  items: readonly FullLayoutMiniMapItem[];
  viewport: FlowViewport;
  size: ViewportSize;
  className?: string;
  onPanTo?: (point: { x: number; y: number }) => void;
}

function drawRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function drawItem(ctx: CanvasRenderingContext2D, rect: FullLayoutMiniMapBase["rects"][number]) {
  const isStructure = rect.kind === "lane" || rect.kind === "pool";
  const width = isStructure ? Math.max(0.5, rect.mapWidth) : Math.max(1.5, rect.mapWidth);
  const height = isStructure ? Math.max(0.5, rect.mapHeight) : Math.max(1.5, rect.mapHeight);
  const x = rect.mapX;
  const y = rect.mapY;

  ctx.save();
  ctx.globalAlpha = rect.opacity ?? (isStructure ? 0.5 : 1);
  ctx.fillStyle = rect.color;
  ctx.strokeStyle = isStructure ? "rgba(0, 0, 0, 0.12)" : "rgba(0, 0, 0, 0.35)";
  ctx.lineWidth = isStructure ? 0.5 : 1;

  if (rect.kind === "lane" || rect.kind === "pool") {
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
    ctx.restore();
    return;
  }

  switch (rect.shape) {
    case "circle": {
      const radius = Math.min(width, height) / 2;
      ctx.beginPath();
      ctx.arc(x + width / 2, y + height / 2, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "diamond": {
      ctx.beginPath();
      ctx.moveTo(x + width / 2, y);
      ctx.lineTo(x + width, y + height / 2);
      ctx.lineTo(x + width / 2, y + height);
      ctx.lineTo(x, y + height / 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "document": {
      const dip = Math.min(height * 0.18, 4);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + width, y);
      ctx.lineTo(x + width, y + height - dip);
      ctx.quadraticCurveTo(x + width * 0.75, y + height, x + width / 2, y + height - dip / 2);
      ctx.quadraticCurveTo(x + width * 0.25, y + height - dip * 1.5, x, y + height - dip);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "rounded": {
      drawRoundRect(ctx, x, y, width, height, Math.min(width, height) / 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    default: {
      drawRoundRect(ctx, x, y, width, height, Math.min(width, height) * 0.25);
      ctx.fill();
      ctx.stroke();
      break;
    }
  }

  ctx.restore();
}

function drawBaseLayer(
  ctx: CanvasRenderingContext2D,
  base: FullLayoutMiniMapBase,
  background: string,
) {
  ctx.clearRect(0, 0, base.width, base.height);
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, base.width, base.height);

  for (const rect of base.rects) {
    if (rect.kind === "lane" || rect.kind === "pool") drawItem(ctx, rect);
  }
  for (const rect of base.rects) {
    if (rect.kind === "node" || !rect.kind) drawItem(ctx, rect);
  }
}

function drawViewportRect(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
) {
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.lineWidth = 2;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

export function FullLayoutMiniMap({
  items,
  viewport,
  size,
  className,
  onPanTo,
}: FullLayoutMiniMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const base = useMemo(() => computeFullLayoutMiniMapBase(items, MINI_MAP_PANEL), [items]);
  const viewportRect = useMemo(
    () => (base ? computeFullLayoutMiniMapViewportRect(base, viewport, size) : null),
    [base, viewport, size],
  );

  useEffect(() => {
    if (!base) {
      baseCanvasRef.current = null;
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = MINI_MAP_WIDTH;
    canvas.height = MINI_MAP_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const host = canvasRef.current;
    const background = host
      ? getComputedStyle(host).getPropertyValue("--color-background").trim()
      : "";
    drawBaseLayer(ctx, base, background || "#eef4f9");
    baseCanvasRef.current = canvas;
  }, [base]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const targetWidth = MINI_MAP_WIDTH * dpr;
    const targetHeight = MINI_MAP_HEIGHT * dpr;
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
      canvas.width = targetWidth;
      canvas.height = targetHeight;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MINI_MAP_WIDTH, MINI_MAP_HEIGHT);
    if (!base || !viewportRect || !baseCanvasRef.current) return;
    ctx.drawImage(baseCanvasRef.current, 0, 0, MINI_MAP_WIDTH, MINI_MAP_HEIGHT);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, MINI_MAP_WIDTH, MINI_MAP_HEIGHT);
    ctx.clip();
    drawViewportRect(ctx, viewportRect);
    ctx.restore();
  }, [base, viewportRect]);

  const panFromEvent = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (!base || !onPanTo) return;
      const rect = event.currentTarget.getBoundingClientRect();
      onPanTo(pointForMiniMapPosition(base, event.clientX - rect.left, event.clientY - rect.top));
    },
    [base, onPanTo],
  );

  if (!base) return null;

  return (
    <div
      className={cn(
        "nodrag nopan nowheel absolute bottom-3 right-3 z-10 overflow-hidden rounded-[var(--radius)] border border-border bg-background shadow-sm",
        onPanTo ? "cursor-crosshair" : "pointer-events-none",
        className,
      )}
      data-full-layout-minimap="true"
      style={{ width: MINI_MAP_WIDTH, height: MINI_MAP_HEIGHT }}
      title="Full layout overview"
      onPointerDown={(event) => {
        if (!onPanTo) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        panFromEvent(event);
      }}
      onPointerMove={(event) => {
        if (!onPanTo || event.buttons !== 1) return;
        panFromEvent(event);
      }}
    >
      <canvas ref={canvasRef} className="block h-full w-full" aria-label="Full layout overview" />
    </div>
  );
}
