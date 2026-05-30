import type { ComponentType } from "react";
import {
  Lightbulb,
  GitBranch,
  Play,
  Scale,
  ScrollText,
  FlaskConical,
  Circle,
  BookMarked,
  UserRound,
  HelpCircle,
} from "lucide-react";
import { NODE_TYPE_META } from "../lib/node-types";

export type NodeTypeIconProps = {
  /** The node type, e.g. "decision". Unknown types fall back to a generic icon. */
  type: string;
  size?: number;
  className?: string;
};

/**
 * Binds the lucide icon component *names* declared in the per-type registry
 * (`NODE_TYPE_META`) to their actual components. This file is the only module
 * that imports React/lucide, so the registry itself stays a server-safe,
 * pure-data module.
 */
type IconComponent = ComponentType<{ size?: number; className?: string; "aria-hidden"?: boolean }>;

const ICON_COMPONENTS: Record<string, IconComponent> = {
  Lightbulb,
  GitBranch,
  Play,
  Scale,
  ScrollText,
  FlaskConical,
  Circle,
  BookMarked,
  UserRound,
  HelpCircle,
};

const ICONS: Record<string, IconComponent> = Object.fromEntries(
  Object.entries(NODE_TYPE_META).map(([type, meta]) => [type, ICON_COMPONENTS[meta.iconName]]),
);

/**
 * Renders the canonical lucide icon for a node type. The per-type icon names
 * live in `NODE_TYPE_META`, the single visual source of truth; unknown types
 * fall back to a generic icon.
 */
export function NodeTypeIcon({ type, size = 16, className }: NodeTypeIconProps) {
  const common = { size, className, "aria-hidden": true } as const;
  const Icon = ICONS[type] ?? HelpCircle;
  return <Icon {...common} />;
}
