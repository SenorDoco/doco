import { Bug, Lightbulb, Menu } from "lucide-react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Form, NavLink } from "react-router";
import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";
import { cn } from "~/lib/cn";
import type { CurrentPrincipal } from "~/lib/session.server";

/** Uncleared bug / idea tallies that drive the owner-only header flags. */
export interface FeedbackPending {
  bugs: number;
  ideas: number;
}

interface SiteHeaderProps {
  /** Currently signed-in Principal. */
  me?: CurrentPrincipal | null;
  /** Root shell headers stay visible while route-level headers are suppressed. */
  shellOwner?: boolean;
  /**
   * Uncleared bug/idea counts. Only the owner's root loader supplies this;
   * it renders the bug/lightbulb flags beside the version pill.
   */
  feedbackPending?: FeedbackPending | null;
  /**
   * Pending access requests sitting in the viewer's owner inbox. The root
   * loader supplies it; the nav surfaces an "Access requests" entry with this
   * count when it's > 0 so owners actually notice requests waiting on them.
   */
  accessRequestsPending?: number | null;
}

// Shared nav-button styling, hoisted so the access-requests entry matches the
// other nav items pixel-for-pixel. `text-left` keeps a bare <button> (Sign out)
// from inheriting the UA-default centered text in the stacked mobile menu.
const navButtonClass =
  "neu-button whitespace-nowrap rounded-md border border-border px-3 py-1.5 text-left font-semibold";
const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  cn(navButtonClass, isActive ? "text-primary" : "text-foreground hover:text-primary");

const SiteHeaderSuppressionContext = createContext(false);

export function SiteHeaderSuppressionProvider({ children }: { children: React.ReactNode }) {
  return (
    <SiteHeaderSuppressionContext.Provider value={true}>
      {children}
    </SiteHeaderSuppressionContext.Provider>
  );
}

export function SiteHeader({
  me,
  shellOwner = false,
  feedbackPending,
  accessRequestsPending,
}: SiteHeaderProps) {
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
          <FeedbackFlags feedbackPending={feedbackPending} />
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-3 text-xs">
          {me ? (
            <>
              {/* lg+: nav rendered inline. */}
              <nav className="hidden items-center gap-3 lg:flex">
                <NavButtons me={me} accessRequestsPending={accessRequestsPending} />
              </nav>
              {/* < lg: collapsed into a hamburger popover so the
                  buttons don't crowd the title / version pill. */}
              <MobileNavMenu me={me} accessRequestsPending={accessRequestsPending} />
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

/**
 * Owner-only flags beside the version pill: a bug icon while any bug report
 * is uncleared, a lightbulb while any idea is. Both link to /feedback, where
 * they're cleared. Renders nothing when there's nothing pending (or for
 * anyone but the owner, whose loader passes no counts).
 */
export function FeedbackFlags({ feedbackPending }: { feedbackPending?: FeedbackPending | null }) {
  const bugs = feedbackPending?.bugs ?? 0;
  const ideas = feedbackPending?.ideas ?? 0;
  if (bugs === 0 && ideas === 0) return null;

  const title = [
    bugs > 0 ? `${bugs} uncleared bug${bugs === 1 ? "" : "s"}` : "",
    ideas > 0 ? `${ideas} uncleared idea${ideas === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <NavLink
      to="/feedback"
      title={title}
      aria-label={`Feedback: ${title}`}
      className="flex shrink-0 items-center gap-2 text-xs font-semibold leading-none hover:opacity-80"
    >
      {bugs > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-destructive">
          <Bug className="h-4 w-4" aria-hidden="true" />
          {bugs}
        </span>
      ) : null}
      {ideas > 0 ? (
        <span className="inline-flex items-center gap-0.5 text-primary">
          <Lightbulb className="h-4 w-4" aria-hidden="true" />
          {ideas}
        </span>
      ) : null}
    </NavLink>
  );
}

/**
 * The "Access requests" nav entry, shown only while requests are waiting in the
 * viewer's owner inbox. Renders nothing at zero (the common case) so it never
 * clutters the bar — the pending count is the whole reason it appears. Links to
 * /access-requests, where an owner approves or denies.
 */
export function AccessRequestsNavItem({
  pending,
  onNavigate,
}: {
  pending?: number | null;
  onNavigate?: () => void;
}) {
  const count = pending ?? 0;
  if (count <= 0) return null;
  const summary = `${count} pending access request${count === 1 ? "" : "s"}`;
  return (
    <NavLink
      to="/access-requests"
      title={summary}
      aria-label={`Access requests: ${summary}`}
      className={({ isActive }: { isActive: boolean }) =>
        cn(
          navButtonClass,
          "inline-flex items-center gap-1.5",
          isActive ? "text-primary" : "text-foreground hover:text-primary",
        )
      }
      onClick={onNavigate}
    >
      Access requests
      <span
        aria-hidden="true"
        className="inline-flex min-w-[1.25rem] items-center justify-center rounded-full bg-primary px-1.5 py-0.5 text-[0.65rem] font-bold leading-none text-primary-foreground"
      >
        {count}
      </span>
    </NavLink>
  );
}

function NavButtons({
  me,
  accessRequestsPending,
  onNavigate,
}: {
  me: CurrentPrincipal;
  accessRequestsPending?: number | null;
  onNavigate?: () => void;
}) {
  return (
    <>
      <AccessRequestsNavItem pending={accessRequestsPending} onNavigate={onNavigate} />
      <NavLink to="/workspaces" className={navLinkClass} onClick={onNavigate}>
        Workspaces
      </NavLink>
      <NavLink to="/integrations" className={navLinkClass} onClick={onNavigate}>
        App integrations
      </NavLink>
      <NavLink to="/users" className={navLinkClass} onClick={onNavigate}>
        Collaborators
      </NavLink>
      <NavLink to="/tokens" className={navLinkClass} onClick={onNavigate}>
        Tokens/MCP
      </NavLink>
      {me.username === "torrenegra" ? (
        <NavLink to="/feedback" className={navLinkClass} onClick={onNavigate}>
          Feedback
        </NavLink>
      ) : null}
      <NavLink
        to={`/users/${me.username}`}
        className={cn(navButtonClass, "text-foreground hover:text-primary")}
        onClick={onNavigate}
      >
        @{me.username}
      </NavLink>
      <Form method="post" action="/sign-out" className="contents">
        <button type="submit" className={cn(navButtonClass, "text-foreground hover:text-primary")}>
          Sign out
        </button>
      </Form>
    </>
  );
}

function MobileNavMenu({
  me,
  accessRequestsPending,
}: {
  me: CurrentPrincipal;
  accessRequestsPending?: number | null;
}) {
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
        <MobileNavPanel
          me={me}
          accessRequestsPending={accessRequestsPending}
          onNavigate={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The hamburger popover panel. Extracted from {@link MobileNavMenu} so its
 * stacking class is unit-testable via SSR — the live menu only mounts the
 * panel on click (client state), so a server-rendered <SiteHeader> never
 * includes it.
 *
 * Stacking: the popover and the doco page's floating detail dialog share the
 * root stacking context (the shell wrappers in `root.tsx` set no z-index), so
 * the popover must outrank everything the page can float beneath the header —
 * the node/edge dialog layer at `z-[100]` (`$docoHandle._index.tsx`) and Señor
 * Doco's overlay drawer at `z-120` (`app.css`). As the outermost, always-
 * present navigation chrome, it sits at the top of that ladder.
 */
export function MobileNavPanel({
  me,
  accessRequestsPending,
  onNavigate,
}: {
  me: CurrentPrincipal;
  accessRequestsPending?: number | null;
  onNavigate?: () => void;
}) {
  return (
    <div
      aria-label="Navigation"
      className="neu-floating absolute right-0 top-full z-[130] mt-2 flex w-48 flex-col gap-2 rounded-md bg-card p-2"
    >
      <NavButtons me={me} accessRequestsPending={accessRequestsPending} onNavigate={onNavigate} />
    </div>
  );
}
