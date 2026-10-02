// GET|POST /digest/unsubscribe?t=<token> — the activity digest's unsubscribe
// link (lib/activity-digest.server.ts). Opening it unsubscribes the person
// from that workspace's digest in one click, without signing in, and offers to
// subscribe again (/digest/subscribe). A mail client's one-click unsubscribe
// (List-Unsubscribe-Post) POSTs here.
import { withClient } from "@doco/db";
import { DigestSubscription, type DigestSubscriptionView } from "~/components/digest-subscription";
import { readUnsubscribeToken, setDigestSubscription } from "~/lib/activity-digest.server";

export function meta() {
  return [{ title: "Activity digest · Doco" }];
}

export async function loader({ request }: { request: Request }) {
  return unsubscribe(request);
}

export async function action({ request }: { request: Request }) {
  return unsubscribe(request);
}

async function unsubscribe(request: Request): Promise<DigestSubscriptionView> {
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const membership = readUnsubscribeToken(token);
  if (!membership) return { state: "invalid" };
  const workspaceHandle = await withClient((c) => setDigestSubscription(c, membership, false));
  return workspaceHandle ? { state: "unsubscribed", workspaceHandle, token } : { state: "gone" };
}

export default function DigestUnsubscribe({
  loaderData,
  actionData,
}: {
  loaderData: DigestSubscriptionView;
  actionData?: DigestSubscriptionView;
}) {
  return <DigestSubscription view={actionData ?? loaderData} />;
}
