import { Menu } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
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
    <header className="neu-header h-14 border-b border-border bg-card">
      <div className="flex h-full w-full items-center gap-6 px-6">
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
              {/* lg+: nav rendered inline. */}
              <nav className="hidden items-center gap-3 lg:flex">
                <NavButtons me={me} />
              </nav>
              {/* < lg: collapsed into a hamburger popover so the
                  buttons don't crowd the title / version pill. */}
              <MobileNavMenu me={me} />
            </>
          ) : (
            <NavLink
              to="/sign-in"
              className="neu-button whitespace-nowrap rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground hover:opacity-90"
            >
              Sign in
            </NavLink>
          )}
        </div>
      </div>
    </header>
  );
}

function NavButtons({ me, onNavigate }: { me: CurrentPrincipal; onNavigate?: () => void }) {
  const navButtonClass =
    "neu-button whitespace-nowrap rounded-md border border-border px-3 py-1.5 font-semibold";
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(navButtonClass, isActive ? "text-primary" : "text-foreground hover:text-primary");
  return (
    <>
      <NavLink to="/docos" className={linkClass} onClick={onNavigate}>
        Docos
      </NavLink>
      <NavLink to="/orgs" className={linkClass} onClick={onNavigate}>
        Orgs
      </NavLink>
      <NavLink to="/integrations" className={linkClass} onClick={onNavigate}>
        Integrations
      </NavLink>
      <NavLink to="/users" className={linkClass} onClick={onNavigate}>
        Collaborators
      </NavLink>
      <NavLink to="/api-keys" className={linkClass} onClick={onNavigate}>
        Access tokens
      </NavLink>
      {me.username === "torrenegra" ? (
        <NavLink to="/mentor/feedback" className={linkClass} onClick={onNavigate}>
          Feedback
        </NavLink>
      ) : null}
      <NavLink
        to={`/users/${me.username}`}
        className="neu-button whitespace-nowrap rounded-full border border-border px-3 py-1.5 font-semibold text-foreground hover:text-primary"
        onClick={onNavigate}
      >
        {me.username}
      </NavLink>
      <Form method="post" action="/sign-out" className="contents">
        <button type="submit" className={cn(navButtonClass, "text-foreground hover:text-primary")}>
          Sign out
        </button>
      </Form>
    </>
  );
}

function MobileNavMenu({ me }: { me: CurrentPrincipal }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative lg:hidden">
      <button
        type="button"
        aria-label="Open navigation menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="neu-button inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-foreground hover:text-primary"
      >
        <Menu className="h-4 w-4" />
      </button>
      {open ? (
        <div
          aria-label="Navigation"
          className="neu-floating absolute right-0 top-full z-50 mt-2 flex w-48 flex-col gap-2 rounded-md bg-card p-2"
        >
          <NavButtons me={me} onNavigate={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  );
}
