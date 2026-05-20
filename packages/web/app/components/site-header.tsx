import { createContext, useContext } from "react";
import { Form, NavLink } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { cn } from "~/lib/cn";
import type { CurrentPrincipal } from "~/lib/session";

interface SiteHeaderProps {
  /**
   * When set, renders the breadcrumb and per-Doco nav.
   *
   * `handle` is the canonical URL identifier (phase 2d+). `ownerSlug`
   * and `docoSlug` are kept as optional inputs for callers that still
   * thread the legacy slug pair; they're used for the breadcrumb label
   * only, never for building URLs.
   */
  docoScope?: { handle: string; ownerSlug?: string; docoSlug?: string };
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

/**
 * Two-row header: brand + breadcrumb + account on row 1, per-Doco
 * navigation on row 2 (sub-bar). Keeps the nav uncrowded as it grows.
 */
export function SiteHeader({ docoScope, me, shellOwner = false }: SiteHeaderProps) {
  const suppressed = useContext(SiteHeaderSuppressionContext);
  if (suppressed && !shellOwner) return null;

  // Per-Doco nav: per-type entity tabs and Search moved off the nav bar —
  // the Doco home is the chronological feed AND the search front door.
  // Breadcrumb label is the handle (the canonical URL identifier).
  // The old `<owner>/<slug>` compound is gone — after slug-removal it
  // would render as `<owner>/<handle>` which doubles the owner prefix
  // visually (e.g. "torrenegra/torrenegra-doco").
  // Per-doco sub-bar; host-mode shows nothing here (top-bar links cover
  // Docos / Orgs / Users / account).
  const nav = docoScope
    ? [
        { to: `/${docoScope.handle}`, label: docoScope.handle, isDocoName: true },
        { to: `/${docoScope.handle}/settings`, label: "Settings", isDocoName: false },
      ]
    : [];

  return (
    <header className="border-b border-border bg-card">
      {/* Row 1: brand + breadcrumb + (host-mode) account actions. */}
      <div className="flex w-full items-center gap-6 px-6 py-3">
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
                to="/dashboard"
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-input",
                    isActive ? "bg-input" : "",
                  )
                }
              >
                Docos
              </NavLink>
              <NavLink
                to="/orgs"
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-input",
                    isActive ? "bg-input" : "",
                  )
                }
              >
                Orgs
              </NavLink>
              <NavLink
                to="/users"
                className={({ isActive }) =>
                  cn(
                    "whitespace-nowrap rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-input",
                    isActive ? "bg-input" : "",
                  )
                }
              >
                Users (human/agents)
              </NavLink>
              <NavLink
                to={`/${me.username}`}
                className="whitespace-nowrap rounded-full border border-border bg-input px-3 py-1 font-semibold text-foreground hover:border-primary"
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
              className="whitespace-nowrap rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground hover:opacity-90"
            >
              Sign in
            </NavLink>
          )}
        </div>
      </div>

      {/* Row 2: per-Doco sub-bar. Rendered only when we're inside a
          docoScope; host-mode pages get the top-bar links as their nav. */}
      {nav.length > 0 ? (
        <div className="border-t border-border/60">
          <nav className="flex w-full items-center gap-5 px-6 py-2 text-xs">
            {nav.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.to === "/" || (docoScope?.handle ? n.to === `/${docoScope.handle}` : false)}
                className={({ isActive }) =>
                  cn(
                    "transition-colors",
                    n.isDocoName
                      ? "font-bold text-foreground"
                      : isActive
                        ? "text-foreground font-medium"
                        : "text-muted-foreground hover:text-foreground",
                  )
                }
              >
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
