import type { ReactNode } from "react";
import { Link } from "react-router";

export type InviteUserLevel = "org" | "doco";

export function usersHref(level: InviteUserLevel, targetId: string): string {
  const params = new URLSearchParams();
  params.set("scope", `${level}:${targetId}`);
  return `/users?${params.toString()}`;
}

export function UsersLink({
  level,
  targetId,
  className,
  children = "Users",
}: {
  level: InviteUserLevel;
  targetId: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Link
      to={usersHref(level, targetId)}
      className={["neu-button shrink-0 rounded-md px-3 py-1.5 text-xs font-semibold", className]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </Link>
  );
}

/**
 * Convenience link to the host-level /api-keys page. Personal access
 * tokens are owned per-user, not per-org or per-doco, so there's no
 * scope filter to set — clicking just goes to the user's full list.
 */
export function ApiKeysLink({
  className,
  children = "Access tokens",
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
