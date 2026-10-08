// The Show more button under a long Doco home list: it raises the list's
// limit param by another page and keeps every other param, so the view (its
// perspective, filters, selected channel) stays as it was. See ~/lib/list-limit.

import { Link, useSearchParams } from "react-router";
import { LIST_PAGE } from "~/lib/list-limit";

export function ShowMoreLink({ param, limit }: { param: string; limit: number }) {
  const [searchParams] = useSearchParams();
  const next = new URLSearchParams(searchParams);
  next.set(param, String(limit + LIST_PAGE));
  return (
    <Link
      to={`?${next.toString()}`}
      preventScrollReset
      className="neu-button neu-small mt-2 inline-block rounded-md px-2 py-1 text-xs font-semibold"
    >
      Show more
    </Link>
  );
}
