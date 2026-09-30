// One icon per kind of Doco, keyed by the template it was created from
// (docos.data.template_handle). Docos that copy from another service wear
// that service's brand mark. A Doco without a known template gets the
// generic page icon.

import {
  BookA,
  BotMessageSquare,
  Bug,
  CircleDot,
  CircleHelp,
  FileText,
  FlaskConical,
  FolderCode,
  Landmark,
  Lightbulb,
  ListChecks,
  type LucideIcon,
  Map as MapIcon,
  Network,
  Package,
  Palette,
  Workflow,
} from "lucide-react";
import { GitHubIcon, NotionIcon, SlackIcon } from "~/components/brand-icons";
import { cn } from "~/lib/cn";
import { findDocoTemplateMeta } from "~/lib/doco-templates-meta";

type IconComponent = LucideIcon | typeof SlackIcon;

export const DOCO_TYPE_ICONS: Record<string, IconComponent> = {
  generic: FileText,
  process: Workflow,
  "github-pull-requests": GitHubIcon,
  // GitHub's own mark for an issue.
  "github-bugs": CircleDot,
  codebase: FolderCode,
  slack: SlackIcon,
  notion: NotionIcon,
  "architectural-decisions": Landmark,
  "product-decisions": Package,
  "design-decisions": Palette,
  glossary: BookA,
  "org-chart": Network,
  evals: FlaskConical,
  "product-roadmap": MapIcon,
  "test-scenarios": ListChecks,
  faq: CircleHelp,
  bugs: Bug,
  ideas: Lightbulb,
  "agents-chats": BotMessageSquare,
};

export function DocoTypeIcon({
  template,
  className,
}: {
  template: string | null;
  className?: string;
}) {
  const Icon = (template && DOCO_TYPE_ICONS[template]) || FileText;
  const label = (template && findDocoTemplateMeta(template)?.label) || "Doco";
  return <Icon aria-label={label} className={cn("h-4 w-4 shrink-0", className)} />;
}
