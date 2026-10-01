// Pieces both readers' views share: the home beside the Doco's activity, the
// bar above a file or page, its "Copy link", and search words marked in a match.
import { Check, Link2 } from "lucide-react";
import { Fragment, type ReactNode, useState } from "react";
import { ActivityColumn } from "~/components/doco-activity";
import type { DocoActivity } from "~/lib/doco-activity.server";

/**
 * The reader's home with the Doco's activity column, as every Doco home has
 * it: beside the home on a wide screen, below it on a narrow one.
 */
export function ReaderHome({
  handle,
  activity,
  children,
}: {
  handle: string;
  activity: DocoActivity;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-x-5 xl:grid-cols-[minmax(0,1fr)_320px] xl:items-start">
      <div className="min-w-0">{children}</div>
      <aside aria-label="Doco activity" className="min-w-0 px-4 pb-6 sm:px-6 xl:pl-0 xl:pt-6">
        <ActivityColumn activity={activity} handle={handle} />
      </aside>
    </div>
  );
}

/** The bar above an open folder, file or page: where it is, and its facts. */
export const BAR =
  "sticky top-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-card/95 px-4 py-2.5 backdrop-blur-sm";
export const META =
  "ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground";
export const META_LINK = "inline-flex items-center gap-1 hover:text-foreground";

export const plural = (n: number, one: string, many: string) =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Copies the page's address, as it stands (a line link included). */
export function CopyLink() {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={META_LINK}
      onClick={() => {
        void navigator.clipboard?.writeText(window.location.href).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check aria-hidden className="h-3 w-3" /> : <Link2 aria-hidden className="h-3 w-3" />}
      {done ? "Copied" : "Copy link"}
    </button>
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The text with each search word marked. */
export function Marked({ text, query }: { text: string; query: string }) {
  const words = query
    .split(/\s+/)
    .map((word) => word.replace(/^["-]+|"+$/g, ""))
    .filter((word) => word.length > 1);
  if (words.length === 0) return <>{text}</>;
  const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "gi");
  return (
    <>
      {text.split(pattern).map((part, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never move
          <mark key={i}>{part}</mark>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: parts never move
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
