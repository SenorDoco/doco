import { Form, NavLink } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { cn } from "~/lib/cn";
import type { CurrentPrincipal } from "~/lib/session";

interface SiteHeaderProps {
  /** When set, renders the breadcrumb (owner / doco) and per-Doco nav. */
  docoScope?: { ownerSlug: string; docoSlug: string };
  /**
   * Mode parameter — historically toggled host vs. single-doco shape (per ADR-093
   * single-doco mode is removed). Kept on the props for caller-site compatibility;
   * the only legal value today is "host". The branch fields a tighter type later.
   */
  mode: "host";
  /** Currently signed-in Principal. */
  me?: CurrentPrincipal | null;
}

/**
 * Two-row header: brand + breadcrumb + account on row 1, per-Doco
 * navigation on row 2 (sub-bar). Keeps the nav uncrowded as it grows.
 */
export function SiteHeader({ docoScope, me }: SiteHeaderProps) {
  // Per-Doco nav: per-type entity tabs and Search moved off the nav bar —
  // the Doco home is the chronological feed AND the search front door
  // (ADR-120 + the search-input-at-doco-home Decision).
  const nav = docoScope
    ? [
        {
          to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}`,
          label: `${docoScope.ownerSlug}/${docoScope.docoSlug}`,
        },
        // The /constitution tab was removed per
        // decision_01KRPNZY7W6CCMYNKGND67BP0B — the Global scope (formerly
        // "Constitution") appears first on /scopes with the caption "the
        // doco's constitution" next to its name. Edit it like any other
        // scope from /scopes/<id>.
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/scopes`, label: "Scopes" },
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/settings`, label: "Settings" },
      ]
    : [
        { to: "/dashboard", label: "Docos" },
        { to: "/agents", label: "Agents" },
      ];

  return (
    <header className="border-b border-border bg-card">
      {/* Row 1: brand + breadcrumb + (host-mode) account actions. */}
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
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
                to="/onboarding/create"
                className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-input"
              >
                + Doco
              </NavLink>
              <NavLink
                to="/new-org"
                className="whitespace-nowrap rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-input"
              >
                + Org
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

      {/* Row 2: per-Doco / host nav (sub-bar, ADR-088). */}
      <div className="border-t border-border/60">
        <nav className="mx-auto flex max-w-6xl items-center gap-5 px-6 py-2 text-xs">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/" || n.to === `/${docoScope?.ownerSlug}/${docoScope?.docoSlug}`}
              className={({ isActive }) =>
                cn(
                  "transition-colors",
                  isActive
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
    </header>
  );
}
