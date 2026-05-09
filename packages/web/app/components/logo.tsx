import { cn } from "~/lib/cn";

interface LogoProps {
  className?: string;
  size?: number;
}

/**
 * Evalo wordmark logo. Uses currentColor so it picks up theme tokens (e.g., text-primary).
 * Kept inline so the SiteHeader can color-match without an extra HTTP round-trip;
 * `/favicon.svg` ships the same artwork for the browser tab.
 */
export function Logo({ className, size = 20 }: LogoProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 200 200"
      width={size}
      height={size}
      aria-label="Evalo"
      className={cn("inline-block align-[-0.2em]", className)}
      role="img"
    >
      <title>Evalo</title>
      <g fill="currentColor" stroke="currentColor">
        <line x1="62.5" y1="35.048" x2="137.5" y2="35.048" strokeWidth="16" strokeLinecap="round" />
        <line x1="25" y1="100" x2="62.5" y2="35.048" strokeWidth="16" strokeLinecap="round" />
        <line x1="25" y1="100" x2="100" y2="100" strokeWidth="16" strokeLinecap="round" />
        <line x1="100" y1="100" x2="175" y2="100" strokeWidth="16" strokeLinecap="round" />
        <line x1="25" y1="100" x2="62.5" y2="164.952" strokeWidth="16" strokeLinecap="round" />
        <line x1="62.5" y1="164.952" x2="137.5" y2="164.952" strokeWidth="16" strokeLinecap="round" />
        <line x1="62.5" y1="35.048" x2="100" y2="100" strokeWidth="16" strokeLinecap="round" />
        <line x1="62.5" y1="164.952" x2="100" y2="100" strokeWidth="16" strokeLinecap="round" />
        <circle cx="175" cy="100" r="22" />
        <circle cx="137.5" cy="164.952" r="22" />
        <circle cx="62.5" cy="164.952" r="22" />
        <circle cx="25" cy="100" r="22" />
        <circle cx="62.5" cy="35.048" r="22" />
        <circle cx="137.5" cy="35.048" r="22" />
        <circle cx="100" cy="100" r="22" />
      </g>
    </svg>
  );
}
