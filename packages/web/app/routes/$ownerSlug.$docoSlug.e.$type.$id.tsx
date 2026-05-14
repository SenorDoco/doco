// Legacy `/<owner>/<doco>/e/<type>/<id>` URL — 301-redirects to the short
// form at `/<owner>/<doco>/<type>/<id>`. Keeps old logs, bookmarks, ADR
// cross-refs alive. Per `ship-short-entity-urls` Intent + ADR.
import { redirect } from "react-router";
import { entityUrl } from "@doco/shared";

export async function loader({
  params,
  request,
}: {
  params: { ownerSlug: string; docoSlug: string; type: string; id: string };
  request: Request;
}) {
  const { ownerSlug, docoSlug, type, id } = params;
  const url = new URL(request.url);
  return redirect(
    `${entityUrl({ ownerSlug, docoSlug, nodeType: type, id: id })}${url.search}`,
    301,
  );
}

export default function LegacyRedirect() {
  return null;
}
