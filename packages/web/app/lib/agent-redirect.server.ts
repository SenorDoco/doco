// Shared 308-redirect logic for the /agent/<credential>/<rest> family.
// Each /agent/<credential>/<known-leaf> route delegates here so the
// dispatch logic stays in one place. The reason there's a separate
// route file for each shape (rather than one splat that catches them
// all) is React Router 7's route ranking — a splat loses to the
// existing `:ownerSlug/:docoSlug/<literal>` patterns that have the
// same segment count, so we register the specific leaves explicitly.
import { redirect } from "react-router";

import { rootDir } from "./db.server";

const CREDENTIAL_RE = /^[0-9a-f]{64}$/;

export async function dispatchAgentUrl({
  request,
  cred,
  rest,
}: {
  request: Request;
  cred: string;
  rest: string;
}): Promise<Response> {
  if (!CREDENTIAL_RE.test(cred)) {
    return Response.json({ error: "invalid_credential" }, { status: 401 });
  }
  const { TokenStore } = await import("./tokens.server");
  const store = TokenStore.forDoco(rootDir());
  const session = await store.resolve(cred);
  if (!session) {
    return Response.json({ error: "credential_not_found" }, { status: 401 });
  }
  if (!session.bound_doco_id) {
    return Response.json(
      {
        error: "credential_not_bound",
        hint: "This access URL is not bound to a Doco. Re-onboard via /onboarding/create/agent to mint a per-Doco URL.",
      },
      { status: 401 },
    );
  }

  const url = new URL(request.url);
  const search = new URLSearchParams(url.search);
  search.set("_a", cred);

  let target: string;
  if (rest === "bootstrap.json") {
    // `bootstrap.json` is the access-URL alias for the canonical
    // bootstrap endpoint. Route to the existing handler with
    // `?id=<doco_id>` so its established lookup path runs.
    search.set("id", session.bound_doco_id);
    target = `/api/v1/agent-bootstrap?${search.toString()}`;
  } else {
    // Phase 2d of slug-removal: canonical Doco URLs are
    // `/<doco_id>/...` where doco_id is the ULID stored on the
    // session. Handlers normalize ULID → handle internally; no need
    // to look up the handle here to keep this layer fast.
    target = `/${session.bound_doco_id}/${rest}?${search.toString()}`;
  }
  throw redirect(target, { status: 308 });
}
