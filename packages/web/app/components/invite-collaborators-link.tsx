import type { ReactNode } from "react";
import { Link } from "react-router";

export type InviteCollaboratorLevel = "org" | "doco";

export function inviteCollaboratorsHref(level: InviteCollaboratorLevel, targetId: string): string {
  const params = new URLSearchParams();
  params.set("level", level);
  params.set("target_id", targetId);
  return `/collaborators?${params.toString()}`;
}

export function InviteCollaboratorsLink({
  level,
  targetId,
  className,
  children = "Invite collaborators",
}: {
  level: InviteCollaboratorLevel;
  targetId: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Link
      to={inviteCollaboratorsHref(level, targetId)}
      className={[
        "shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-semibold hover:bg-input",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Link>
  );
}
