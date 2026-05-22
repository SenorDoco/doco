import { createContext, useContext } from "react";
import { Form, NavLink } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { cn } from "~/lib/cn";
import type { CurrentPrincipal } from "~/lib/session.server";

interface SiteHeaderProps {
  /**
   * Mode parameter — historically toggled host vs. single-doco shape (per ADR-093
   * single-doco mode is removed). Kept on the props for caller-site compatibility;
   * the only legal value today is "host". The branch fields a tighter type later.
   */
  mode: "host";
  /** Currently signed-in Principal. */
  me?: CurrentPrincipal | null;
  /** Root shell headers stay visible while route-level headers are suppressed. */
  shellOwner?: boolean;
}

const SiteHeaderSuppressionContext = createContext(false);

export function SiteHeaderSuppressionProvider({ children }: { children: React.ReactNode }) {
  return (
    <SiteHeaderSuppressionContext.Provider value={true}>
      {children}
    </SiteHeaderSuppressionContext.Provider>
  );
}

export function SiteHeader({ me, shellOwner = false }: SiteHeaderProps) {
  const suppressed = useContext(SiteHeaderSuppressionContext);
  if (suppressed && !shellOwner) return null;

  return (
    <header className="bg-background">
      <div className="flex w-full items-center gap-6 px-6 py-4">
        <h1 className="m-0 flex min-w-0 items-center gap-3 leading-none">
          <NavLink
            to="/"
            className="inline-flex items-center hover:opacity-80"
            aria-label="Doco home"
          >
            <DocoMark height={28} />
          </NavLink>
          <VersionPill />
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs">
          {me ? (
            <>
              <NavLink
                to="/docos"
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md px-3 py-1.5 font-semibold",
                    isActive ? "neo-pressed" : "neo-raised-sm",
                  )
                }
              >
                Docos
              </NavLink>
              <NavLink
                to="/orgs"
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md px-3 py-1.5 font-semibold",
                    isActive ? "neo-pressed" : "neo-raised-sm",
                  )
                }
              >
                Orgs
              </NavLink>
              <NavLink
                to="/collaborators"
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md px-3 py-1.5 font-semibold",
                    isActive ? "neo-pressed" : "neo-raised-sm",
                  )
                }
              >
                Collaborators
              </NavLink>
              <NavLink
                to={`/${me.username}`}
                className="neo-raised-sm whitespace-nowrap rounded-full px-3 py-1 font-semibold text-foreground hover:text-primary"
              >
                {me.username}
              </NavLink>
              <Form method="post" action="/sign-out">
                <button
                  type="submit"
                  className="text-muted-foreground hover:text-foreground transition-colors"
                >
                  Sign out
                </button>
              </Form>
            </>
          ) : (
            <NavLink
              to="/sign-in"
              className="neo-raised-primary whitespace-nowrap rounded-md px-3 py-1.5 font-semibold"
            >
              Sign in
            </NavLink>
          )}
        </div>
      </div>
    </header>
  );
}
