// GET|POST /digest/subscribe?t=<token> — the unsubscribe page's "Subscribe
// again" button POSTs here to turn the person's activity digest for that
// workspace back on; GET shows whether they get it. The token is the one the
// unsubscribe link carries (lib/activity-digest.server.ts).
import { withClient } from "@doco/db";
import { DigestSubscription, type DigestSubscriptionView } from "~/components/digest-subscription";
import {
  loadDigestSubscription,
  readUnsubscribeToken,
  setDigestSubscription,
} from "~/lib/activity-digest.server";

export function meta() {
  return [{ title: "Activity digest · Doco" }];
}

export async function loader({ request }: { request: Request }): Promise<DigestSubscriptionView> {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const membership = readUnsubscribeToken(token);
  if (!membership) return { state: "invalid" };
  const found = await withClient((c) => loadDigestSubscription(c, membership));
  if (!found) return { state: "gone" };
  return {
    state: found.subscribed ? "subscribed" : "unsubscribed",
    workspaceHandle: found.workspaceHandle,
    token,
  };
}

export async function action({ request }: { request: Request }) {
  const membership = readUnsubscribeToken(new URL(request.url).searchParams.get("t") ?? "");
  if (membership) await withClient((c) => setDigestSubscription(c, membership, true));
  return null;
}

export default function DigestSubscribe({ loaderData }: { loaderData: DigestSubscriptionView }) {
  return <DigestSubscription view={loaderData} />;
}
