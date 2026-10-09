// GET|POST /digest/daily|weekly|unsubscribe?t=<token> — the activity digest's
// links (lib/activity-digest.ts): the button that switches it between daily
// and weekly, and the unsubscribe link. Opening one sets how often the person
// gets that workspace's digest in one click, without signing in, and offers
// the other choices. A mail client's one-click unsubscribe
// (List-Unsubscribe-Post) POSTs here.
import { withClient } from "@doco/db";
import { DigestSubscription, type DigestSubscriptionView } from "~/components/digest-subscription";
import type { DigestSetting } from "~/lib/activity-digest";
import { readDigestToken, setDigest } from "~/lib/activity-digest.server";

/** What each link sets. */
const SETTINGS = new Map<string, DigestSetting>([
  ["daily", "daily"],
  ["weekly", "weekly"],
  ["unsubscribe", "off"],
]);

export function meta() {
  return [{ title: "Activity digest · Doco" }];
}

type Args = { request: Request; params: { setting?: string } };

export async function loader(args: Args) {
  return set(args);
}

export async function action(args: Args) {
  return set(args);
}

async function set({ request, params }: Args): Promise<DigestSubscriptionView> {
  const setting = SETTINGS.get(params.setting ?? "");
  if (!setting) throw new Response("Not found", { status: 404 });
  const token = new URL(request.url).searchParams.get("t") ?? "";
  const membership = readDigestToken(token);
  if (!membership) return { state: "invalid" };
  const workspaceHandle = await withClient((c) => setDigest(c, membership, setting));
  return workspaceHandle ? { state: setting, workspaceHandle, token } : { state: "gone" };
}

export default function Digest({
  loaderData,
  actionData,
}: {
  loaderData: DigestSubscriptionView;
  actionData?: DigestSubscriptionView;
}) {
  return <DigestSubscription view={actionData ?? loaderData} />;
}
