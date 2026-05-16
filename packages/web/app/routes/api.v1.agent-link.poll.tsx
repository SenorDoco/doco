import { TokenStore } from "~/lib/tokens.server";
import { rootDir } from "~/lib/db.server";

/**
 * GET /api/v1/agent-link/poll?state_nonce=<nonce> — Wait for the
 * project owner to approve in the browser. The agent polls this
 * endpoint with the `state_nonce` it got from /api/v1/agent-link/start.
 *
 * Why GET (not POST): see /api/v1/agent-link/start. Plain GETs read
 * to agent permission classifiers the same as fetching /llms.txt —
 * no state-mutation signal, no body, no prompt on every call.
 *
 * Query params (required):
 *   ?state_nonce=<nonce>   — opaque nonce from /start
 *
 * Output (application/json):
 *   pending   → { status: "pending" }
 *   approved  → {
 *                 status: "approved",
 *                 access_url: "https://<host>/agent/<credential>/",
 *                 owner_slug: string,
 *                 doco_slug: string | null,
 *                 doco_id: string | null,
 *               }
 *   denied    → { status: "denied" }
 *   expired   → { status: "expired" }
 *   not_found → { status: "not_found" } (404)
 *   consumed  → { status: "already_consumed" } (409)
 *
 * The `access_url` is single-use to read — a second poll for the same
 * nonce returns "already_consumed". Persist it immediately
 * (write `DOCO_URL=<access_url>` to ./.env).
 */
export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const state_nonce = (url.searchParams.get("state_nonce") ?? "").trim();
  if (!state_nonce) {
    return Response.json({ error: "missing_state_nonce" }, { status: 400 });
  }

  const store = TokenStore.forDoco(rootDir());
  const row = await store.findCliAuthorizationByState(state_nonce);
  if (!row) {
    return Response.json({ status: "not_found" }, { status: 404 });
  }

  if (row.status === "pending") return Response.json({ status: "pending" });
  if (row.status === "denied") return Response.json({ status: "denied" });
  if (row.status === "expired") return Response.json({ status: "expired" });
  if (row.status === "exchanged") {
    return Response.json({ status: "already_consumed" }, { status: 409 });
  }

  // status === "approved" — single-use consume.
  const consumed = await store.consumeCliAuthorization(state_nonce);
  if (!consumed) {
    return Response.json({ status: "race_lost" }, { status: 409 });
  }

  const origin = `${url.protocol}//${url.host}`;
  const access_url = `${origin}/agent/${consumed.token}/`;

  return Response.json({
    status: "approved",
    access_url,
    owner_slug: consumed.owner_slug,
    doco_slug: consumed.created_doco_slug,
    doco_id: consumed.created_doco_id,
  });
}
