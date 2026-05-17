import type * as React from "react";
import { cn } from "~/lib/cn";

export interface NodeTypeIconProps extends React.SVGAttributes<SVGSVGElement> {
  nodeType: string;
}

function iconPath(nodeType: string) {
  switch (nodeType) {
    case "principal":
      return (
        <>
          <rect x="3.5" y="4.5" width="17" height="15" rx="1.8" />
          <path d="M7.5 4.5v15M7.5 9.5h13M7.5 14.5h13" />
        </>
      );
    case "doco":
      return (
        <>
          <path d="M7 6.5h9.5a2 2 0 0 1 2 2v9H7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z" />
          <path d="M6 6.5V5.8a1.8 1.8 0 0 1 1.8-1.8H17" />
          <circle cx="9" cy="11" r="1.2" />
          <circle cx="14.8" cy="10" r="1.2" />
          <circle cx="13" cy="15" r="1.2" />
          <path d="M10.2 10.8l3.4-.6M9.9 12l2.3 2.2" />
        </>
      );
    case "organization":
      return (
        <>
          <circle cx="12" cy="5.8" r="2" />
          <circle cx="6.5" cy="17.5" r="2" />
          <circle cx="17.5" cy="17.5" r="2" />
          <path d="M12 7.8v4M6.5 15.5v-2H17.5v2" />
        </>
      );
    case "intent":
      return (
        <>
          <circle cx="10" cy="12" r="6.5" />
          <circle cx="10" cy="12" r="3" />
          <path d="M15 6.5h4v5h-4M15 6.5v11" />
        </>
      );
    case "idea":
      return (
        <>
          <path d="M8.3 13.3a5 5 0 1 1 7.4 0c-.9.8-1.2 1.5-1.2 2.4h-5c0-.9-.3-1.6-1.2-2.4Z" />
          <path d="M9.6 18h4.8M10.2 20h3.6M18.5 4.5l1.2-1.2M5.5 4.5 4.3 3.3M20 11h1.8M2.2 11H4" />
        </>
      );
    case "rule":
      return (
        <>
          <path d="M7 3.8h7l3 3v13.4H7a2 2 0 0 1-2-2V5.8a2 2 0 0 1 2-2Z" />
          <path d="M14 3.8V7h3M8.5 10.5h5M8.5 13.5h7" />
          <path d="M10 17l1.4 1.4 3.1-3.4" />
        </>
      );
    case "decision":
      return (
        <>
          <path d="M12 3.5 20.5 12 12 20.5 3.5 12 12 3.5Z" />
          <path d="M9 12h6M12 9v6" />
        </>
      );
    case "action":
      return (
        <>
          <rect x="4" y="7" width="16" height="10" rx="2.2" />
          <path d="M7 12h6.5M15.5 9.5 18 12l-2.5 2.5" />
        </>
      );
    case "log":
      return (
        <>
          <circle cx="12" cy="12" r="7.5" />
          <circle cx="12" cy="12" r="5" />
          <path d="M12 8.5V12l2.6 1.6" />
        </>
      );
    case "eval":
      return (
        <>
          <path d="M12 3.5 20.5 12 12 20.5 3.5 12 12 3.5Z" />
          <path d="m8.2 12.2 2.4 2.4 5.3-5.6" />
        </>
      );
    case "reference":
      return (
        <>
          <path d="M7 3.8h7l3 3v13.4H7a2 2 0 0 1-2-2V5.8a2 2 0 0 1 2-2Z" />
          <path d="M14 3.8V7h3" />
          <path d="M9.2 14.2 8.3 15a2 2 0 0 0 2.8 2.8l1.1-1.1M11.8 11.6l1.1-1.1a2 2 0 0 1 2.8 2.8l-.9.9M10.5 15.5l4-4" />
        </>
      );
    case "scope":
      return (
        <>
          <rect x="4" y="5" width="16" height="14" rx="2" strokeDasharray="2.4 2.4" />
          <path d="M8 9h8M8 12h5M8 15h7" />
        </>
      );
    case "state":
      return (
        <>
          <circle cx="10.5" cy="12" r="5.8" />
          <circle cx="10.5" cy="12" r="3.4" />
          <path d="M16.5 12h3M18.2 9.8 20.5 12l-2.3 2.2" />
        </>
      );
    case "tag":
      return (
        <>
          <path d="M4.5 5.5h7.2L20 13.8 13.8 20 5.5 11.7V5.5Z" />
          <circle cx="8.2" cy="8.2" r="1.1" />
        </>
      );
    default:
      return (
        <>
          <rect x="5" y="5" width="14" height="14" rx="2" />
          <path d="M8.5 9h7M8.5 12h5M8.5 15h7" />
        </>
      );
  }
}

export function NodeTypeIcon({ nodeType, className, ...props }: NodeTypeIconProps) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("h-3.5 w-3.5 shrink-0", className)}
      {...props}
    >
      {iconPath(nodeType)}
    </svg>
  );
}
