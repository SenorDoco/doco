// What the activity digest's links show: how often the person now gets a
// workspace's digest, and the one click that changes it. No sign-in needed:
// the link's token names them.

import { Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";
import { NarrowPageMain } from "~/components/page-main";
import type { DigestSetting } from "~/lib/activity-digest";

export type DigestSubscriptionView =
  | { state: DigestSetting; workspaceHandle: string; token: string }
  /** No longer a member of the workspace. */
  | { state: "gone" }
  /** The link's token was cut short or tampered with. */
  | { state: "invalid" };

const BUTTON =
  "neu-button rounded-md px-4 py-2.5 text-sm font-semibold text-foreground hover:opacity-90";

export function DigestSubscription({ view }: { view: DigestSubscriptionView }) {
  return (
    <NarrowPageMain className="space-y-4 py-10">
      <Card>
        <CardHeader>
          <CardTitle>{TITLES[view.state]}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <Body view={view} />
        </CardContent>
      </Card>
    </NarrowPageMain>
  );
}

const TITLES: Record<DigestSubscriptionView["state"], string> = {
  daily: "You'll get it every day",
  weekly: "You'll get it every Monday",
  off: "You're unsubscribed",
  gone: "You're no longer a member",
  invalid: "This link doesn't work",
};

function Body({ view }: { view: DigestSubscriptionView }) {
  if (view.state === "invalid") {
    return <p>The link is incomplete. Open it again from the digest email.</p>;
  }
  if (view.state === "gone") {
    return <p>You left this workspace, so you won't get its activity digest.</p>;
  }
  const ws = view.workspaceHandle;
  const t = new URLSearchParams({ t: view.token });
  const to = (setting: string) => `/digest/${setting}?${t}`;
  const open = (
    <Link to={`/workspaces/${ws}`} className="text-primary hover:underline">
      Open {ws}
    </Link>
  );
  if (view.state === "off") {
    return (
      <>
        <p>You won't get {ws}'s activity digest anymore.</p>
        <p className="flex items-center gap-4">
          <Link to={to("daily")} className={BUTTON}>
            Subscribe again
          </Link>
          {open}
        </p>
      </>
    );
  }
  const other = view.state === "daily" ? "weekly" : "daily";
  return (
    <>
      <p>
        Each digest covers the previous {view.state === "daily" ? "24 hours" : "7 days"} of activity
        in {ws}.
      </p>
      <p className="flex items-center gap-4">
        <Link to={to(other)} className={BUTTON}>
          Switch to {other}
        </Link>
        <Link to={to("unsubscribe")} className="hover:underline">
          Unsubscribe
        </Link>
        {open}
      </p>
    </>
  );
}
