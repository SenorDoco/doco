import type * as React from "react";
import { cn } from "~/lib/cn";

export interface NodeTypeIconProps extends React.SVGAttributes<SVGSVGElement> {
  entityType: string;
}

function iconPath(entityType: string) {
  switch (entityType) {
    case "principal":
      return (
        <>
          <circle cx="12" cy="7.2" r="3" />
          <path d="M5.5 20.2a6.5 6.5 0 0 1 13 0" />
          <path d="M8.2 14.6a5.3 5.3 0 0 1 7.6 0" />
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
          <circle cx="12" cy="12" r="6.2" />
          <circle cx="12" cy="12" r="2.2" />
          <path d="M12 3.8v3M12 17.2v3M3.8 12h3M17.2 12h3" />
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
          <path d="m14 13-7.8 7.8a1.4 1.4 0 0 1-2-2L12 11" />
          <path d="m16 16 5-5" />
          <path d="m13 3 8 8" />
          <path d="m8 8 5-5" />
          <path d="m8.5 7.5 8 8" />
        </>
      );
    case "guidance_primitive":
      return (
        <>
          <path d="M6.5 5.5h11v13h-11z" />
          <path d="M9 9h6M9 12h4M9 15h5" />
        </>
      );
    case "neuron_authoring_primitive":
      return (
        <>
          <path d="M5.5 6.5h13v11h-13z" />
          <path d="m8.2 12 2.1 2.1 5.5-5.7" />
          <path d="M8.5 18.8h7" />
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
          <rect x="4" y="7" width="16" height="10" rx="1.8" />
        </>
      );
    case "log":
      return (
        <>
          <circle cx="6.5" cy="7.5" r="0.9" />
          <circle cx="6.5" cy="12" r="0.9" />
          <circle cx="6.5" cy="16.5" r="0.9" />
          <path d="M10 7.5h8M10 12h8M10 16.5h8" />
        </>
      );
    case "eval":
      return (
        <>
          <path d="m5.5 12.6 4.2 4.2 8.8-9.4" />
        </>
      );
    case "reference":
      return (
        <>
          <circle cx="11" cy="11" r="5.25" />
          <path d="m15.1 15.1 4.9 4.9" />
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

export function NodeTypeIcon({ entityType, className, ...props }: NodeTypeIconProps) {
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
      {iconPath(entityType)}
    </svg>
  );
}
