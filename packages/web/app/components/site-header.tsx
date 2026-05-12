import { Form, NavLink } from "react-router";
import { cn } from "~/lib/cn";
import { DocoMark } from "~/components/doco-mark";
import type { CurrentPrincipal } from "~/lib/session";

interface SiteHeaderProps {
  /** Used for breadcrumb. In single-doco mode this is the Doco slug; in host mode it's the host name. */
  context: string;
  /** When set, renders the per-Doco nav scoped to this Doco (host mode). */
  docoScope?: { ownerSlug: string; docoSlug: string };
  mode: "host" | "single-doco";
  /** Currently signed-in Principal (host mode only). */
  me?: CurrentPrincipal | null;
}

export function SiteHeader({ context, docoScope, mode, me }: SiteHeaderProps) {
  const nav = docoScope
    ? [
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}`, label: "Recent" },
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/e/scope`, label: "Scopes" },
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/e/intent`, label: "Intents" },
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/e/idea`, label: "Ideas" },
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/e/rule`, label: "Rules" },
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/e/decision`, label: "Decisions" },
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/e/action`, label: "Actions" },
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/search`, label: "Search" },
        { to: `/${docoScope.ownerSlug}/${docoScope.docoSlug}/lint`, label: "Lint" },
      ]
    : mode === "host"
      ? [
          { to: "/", label: "Docos" },
          { to: "/agents", label: "Agents" },
        ]
      : [
          { to: "/", label: "Recent" },
          { to: "/e/scope", label: "Scopes" },
          { to: "/e/intent", label: "Intents" },
          { to: "/e/idea", label: "Ideas" },
          { to: "/e/rule", label: "Rules" },
          { to: "/e/decision", label: "Decisions" },
          { to: "/e/action", label: "Actions" },
          { to: "/search", label: "Search" },
          { to: "/lint", label: "Lint" },
        ];

  return (
    <header className="border-b border-border bg-card">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
        <h1 className="m-0 leading-none tracking-tight">
          <NavLink to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </NavLink>
          <span className="ml-3 font-normal text-xs text-muted-foreground align-middle">
            / {context}
            {docoScope ? (
              <>
                {" / "}
                <NavLink to={`/${docoScope.ownerSlug}`} className="hover:text-foreground">
                  {docoScope.ownerSlug}
                </NavLink>
                {" / "}
                <NavLink
                  to={`/${docoScope.ownerSlug}/${docoScope.docoSlug}`}
                  className="hover:text-foreground"
                >
                  {docoScope.docoSlug}
                </NavLink>
              </>
            ) : null}
          </span>
        </h1>
        <nav className="flex items-center gap-4 text-xs">
          {nav.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.to === "/" || n.to === `/${docoScope?.ownerSlug}/${docoScope?.docoSlug}`}
              className={({ isActive }) =>
                cn(
                  "transition-colors",
                  isActive ? "text-foreground font-medium" : "text-muted-foreground hover:text-foreground",
                )
              }
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-xs">
          {mode === "host" ? (
            me ? (
              <>
                <NavLink
                  to="/new-doco"
                  className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-input"
                >
                  + Doco
                </NavLink>
                <NavLink
                  to="/new-org"
                  className="rounded-md border border-border px-3 py-1.5 font-semibold hover:bg-input"
                >
                  + Org
                </NavLink>
                <NavLink
                  to={`/${me.username}`}
                  className="rounded-full border border-border bg-input px-3 py-1 font-semibold text-foreground hover:border-primary"
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
                className="rounded-md bg-primary px-3 py-1.5 font-semibold text-primary-foreground hover:opacity-90"
              >
                Sign in
              </NavLink>
            )
          ) : null}
        </div>
      </div>
    </header>
  );
}
