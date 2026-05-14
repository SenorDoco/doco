import { rootDir } from "~/lib/db.server";
import { TokenStore } from "~/lib/tokens.server";

/**
 * /claim/:token.json — agent-facing claim-status poll.
 *
 * The wizard hands the agent a `claim_url` of the form /claim/<token>.
 * That URL renders an HTML page intended for the owner who will take
 * ownership. The agent appends ".json" to poll claim status while it
 * reminds the owner (see CANONICAL_INSTRUCTIONS §"While the Doco is
 * unclaimed").
 *
 * Resource route — no default export.
 */
export async function loader({ params }: { params: { token?: string } }) {
  const token = params.token ?? "";
  if (!token) {
    return Response.json({ status: "unknown" as const }, { status: 400 });
  }
  const store = TokenStore.forDoco(rootDir());
  const result = await store.getClaimStatus(token);
  return Response.json(result);
}
