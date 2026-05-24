import type { ReactNode } from "react";
import { Link } from "react-router";

export type InviteCollaboratorLevel = "org" | "doco";

export function collaboratorsHref(level: InviteCollaboratorLevel, targetId: string): string {
  const params = new URLSearchParams();
  params.set("scope", `${level}:${targetId}`);
  return `/collaborators?${params.toString()}`;
}

export function inviteCollaboratorsHref(level: InviteCollaboratorLevel, targetId: string): string {
  const params = new URLSearchParams();
  params.set("level", level);
  params.set("target_id", targetId);
  return `/collaborators/invite?${params.toString()}`;
}

export function CollaboratorsLink({
  level,
  targetId,
  className,
  children = "Collaborators",
}: {
  level: InviteCollaboratorLevel;
  targetId: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Link
      to={collaboratorsHref(level, targetId)}
      className={["neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Link>
  );
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
      className={["neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Link>
  );
}

/**
 * Convenience link to the host-level /api-keys page. API keys are
 * owned per-user, not per-org or per-doco, so there's no scope
 * filter to set — clicking just goes to the user's full key list.
 */
export function ApiKeysLink({
  className,
  children = "API keys",
}: {
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Link
      to="/api-keys"
      className={["neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Link>
  );
}
