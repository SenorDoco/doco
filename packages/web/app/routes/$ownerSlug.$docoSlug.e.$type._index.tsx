// Legacy `/<owner>/<doco>/e/<type>` URL — 301-redirects to the short form
// at `/<owner>/<doco>/<type>`. Keeps old logs, bookmarks, ADR cross-refs alive.
// Per `ship-short-entity-urls` Intent + ADR.
import { redirect } from "react-router";
import { entityListUrl } from "@doco/shared";

export async function loader({
  params,
  request,
}: {
  params: { ownerSlug: string; docoSlug: string; type: string };
  request: Request;
}) {
  const { ownerSlug, docoSlug, type } = params;
  const url = new URL(request.url);
  const search = url.search;
  return redirect(`${entityListUrl({ ownerSlug, docoSlug, nodeType: type })}${search}`, 301);
}

export default function LegacyRedirect() {
  return null;
}
