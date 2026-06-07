import { Globe, Lock } from "lucide-react";
import { cn } from "~/lib/cn";

// One marker for a Doco's visibility, reused everywhere a Doco is named: a
// globe (public) or a padlock (private). The hover title — also the
// aria-label — spells out who can see it, in the same words as the
// Settings → Visibility radios, so the icon is self-explaining on hover and
// to screen readers alike.
const VISIBILITY_LABEL: Record<"public" | "private", string> = {
  public: "Public — anyone with the URL can view",
  private: "Private — only owner / workspace members can view",
};

export function VisibilityIcon({
  visibility,
  className,
}: {
  visibility: "public" | "private";
  className?: string;
}) {
  const label = VISIBILITY_LABEL[visibility];
  const Icon = visibility === "public" ? Globe : Lock;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-visibility={visibility}
      className={cn("inline-flex shrink-0 items-center text-muted-foreground", className)}
    >
      <Icon aria-hidden className="h-3.5 w-3.5" strokeWidth={1.7} />
    </span>
  );
}
