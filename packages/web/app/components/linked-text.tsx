import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";
import { type LinkToken, resolveScalarValue, tokenizeProse } from "~/lib/link-tokens";

// Shared rendering for note/edge dialog text: URLs become hyperlinks (foreign
// ones open in a new tab with a new-window icon) and a Reference `locator`
// resolves to its GitHub blob permalink. The parsing lives in ~/lib/link-tokens
// (unit-tested); this module is the thin React mapping.

const LINK_CLASS = "font-medium text-foreground underline underline-offset-2 hover:text-primary";

function NewWindowIcon() {
  return (
    <ExternalLink aria-hidden="true" className="ml-0.5 inline h-3 w-3 shrink-0 align-[-0.125em]" />
  );
}

/** A foreign link: opens in a new tab and carries the new-window icon. */
function ExternalAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      {children}
      <NewWindowIcon />
    </a>
  );
}

/**
 * A hyperlink token. Same-origin URLs route through React Router (in-app
 * navigation, no new-window icon); foreign URLs open in a new tab with the
 * icon. Dialogs render client-side, so `window` is available.
 */
function UrlLink({ url, label }: { url: string; label: string }) {
  if (typeof window !== "undefined") {
    try {
      const u = new URL(url, window.location.origin);
      if (u.origin === window.location.origin) {
        return (
          <Link to={u.pathname + u.search + u.hash} className={LINK_CLASS}>
            {label}
          </Link>
        );
      }
    } catch {
      // Malformed URL — fall through to a plain external anchor.
    }
  }
  return <ExternalAnchor href={url}>{label}</ExternalAnchor>;
}

function renderTokens(tokens: LinkToken[]): ReactNode[] {
  const out: ReactNode[] = [];
  let key = 0;
  for (const token of tokens) {
    if (token.kind === "text") {
      // Raw text — the container's whitespace-pre-wrap preserves spacing.
      out.push(<span key={key++}>{token.text}</span>);
    } else if (token.kind === "url") {
      out.push(<UrlLink key={key++} url={token.url} label={token.label} />);
    } else {
      out.push(
        <ExternalAnchor key={key++} href={token.url}>
          {token.label}
        </ExternalAnchor>,
      );
    }
  }
  return out;
}

/** Render prose with markdown and bare URLs elevated to links. Inline; the caller wraps. */
export function LinkedProse({ text }: { text: string }) {
  return <>{renderTokens(tokenizeProse(text))}</>;
}

/**
 * Render a single scalar value (a metadata/prop value or a Reference
 * `locator`): a whole-value URL or a code permalink becomes a link; everything
 * else is text (with any embedded URLs still linkified).
 */
export function LinkedValue({ value, githubRepo }: { value: string; githubRepo?: string | null }) {
  return <>{renderTokens(resolveScalarValue(value, githubRepo ?? null))}</>;
}
