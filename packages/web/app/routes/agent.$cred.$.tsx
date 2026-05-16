// /agent/<credential>/<deeper-path> — catch-all for paths under the
// access URL that don't have an explicit registration. The explicit
// sibling files (agent.$cred.search[.]json.tsx, agent.$cred.bootstrap[.]json.tsx,
// agent.$cred.api.$type[.]json.tsx, agent.$cred.api.$type.$id[.]json.tsx,
// agent.$cred.status[.]json.tsx) cover the common shapes — they win the
// route ranking against the `:ownerSlug/:docoSlug/<literal>` catch-alls
// that have the same segment count. This splat exists for everything
// else (e.g. settings, scope subpaths) that the explicit routes don't
// cover.
import { dispatchAgentUrl } from "~/lib/agent-redirect.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { cred: string; "*": string | undefined };
}) {
  return dispatchAgentUrl({
    request,
    cred: params.cred ?? "",
    rest: params["*"] ?? "",
  });
}

export const action = loader;
