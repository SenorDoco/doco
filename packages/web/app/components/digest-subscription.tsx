// What the activity digest's unsubscribe link (and its "Subscribe again"
// button) shows: whether the person still gets a workspace's digest, and the
// one click that changes it. No sign-in needed: the link's token names them.

import { Form, Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/card";

export type DigestSubscriptionView =
  | { state: "subscribed" | "unsubscribed"; workspaceHandle: string; token: string }
  /** No longer a member of the workspace. */
  | { state: "gone" }
  /** The link's token was cut short or tampered with. */
  | { state: "invalid" };

const BUTTON =
  "neu-button rounded-md px-4 py-2.5 text-sm font-semibold text-foreground hover:opacity-90";

export function DigestSubscription({ view }: { view: DigestSubscriptionView }) {
  return (
    <main className="mx-auto max-w-md space-y-4 px-6 py-10">
      <Card>
        <CardHeader>
          <CardTitle>{TITLES[view.state]}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <Body view={view} />
        </CardContent>
      </Card>
    </main>
  );
}

const TITLES: Record<DigestSubscriptionView["state"], string> = {
  subscribed: "You're subscribed",
  unsubscribed: "You're unsubscribed",
  gone: "You're no longer a member",
  invalid: "This link doesn't work",
};

function Body({ view }: { view: DigestSubscriptionView }) {
  if (view.state === "invalid") {
    return <p>The unsubscribe link is incomplete. Open it again from the digest email.</p>;
  }
  if (view.state === "gone") {
    return <p>You left this workspace, so you won't get its activity digest.</p>;
  }
  const ws = view.workspaceHandle;
  const t = new URLSearchParams({ t: view.token });
  const open = (
    <Link to={`/workspaces/${ws}`} className="text-primary hover:underline">
      Open {ws}
    </Link>
  );
  if (view.state === "unsubscribed") {
    return (
      <>
        <p>You won't get {ws}'s activity digest anymore.</p>
        <Form method="post" action={`/digest/subscribe?${t}`} className="flex items-center gap-4">
          <button type="submit" className={BUTTON}>
            Subscribe again
          </button>
          {open}
        </Form>
      </>
    );
  }
  return (
    <>
      <p>You'll get {ws}'s activity digest again.</p>
      <p className="flex items-center gap-4">
        <Link to={`/digest/unsubscribe?${t}`} className="hover:underline">
          Unsubscribe
        </Link>
        {open}
      </p>
    </>
  );
}
