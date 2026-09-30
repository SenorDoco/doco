// The "Get started" card: the three steps that take a person from signing in
// to a working shared memory. /workspaces shows it, and so does the invite
// page once an invite is accepted, so people who join and people who create a
// workspace follow the same steps. Each step reads as done from the
// database (lib/onboarding.server.ts); the card disappears once all three are.

import { CheckCircle2 } from "lucide-react";
import { Link } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import type { OnboardingProgress } from "~/lib/onboarding.server";

const STEPS: ReadonlyArray<{
  key: keyof OnboardingProgress;
  title: string;
  body: string;
  href: string;
  action: string;
}> = [
  {
    key: "workspace",
    title: "Create or join a workspace",
    body: "A workspace holds one project's shared memory: its members, its constitution and its Docos. Join one from an invite, or create one.",
    href: "/new-workspace",
    action: "Create a workspace",
  },
  {
    key: "agent",
    title: "Connect your agent",
    body: "Copy the instructions on the home page and give them to your agent. It connects to Doco and asks which workspace to use.",
    href: "/#instructions",
    action: "Copy the instructions",
  },
  {
    key: "sources",
    title: "Connect sources of knowledge",
    body: "Bring in GitHub pull requests, Slack conversations and Notion pages, so people and agents build on what the team already knows.",
    href: "/integrations",
    action: "Connect sources",
  },
];

export function OnboardingCard({ progress }: { progress: OnboardingProgress }) {
  if (STEPS.every((step) => progress[step.key])) return null;
  return (
    <Card>
      <CardHeader className="px-4 py-3">
        <CardTitle className="text-sm">Get started</CardTitle>
        <CardDescription>
          Three steps to a shared memory for your team and its agents.
        </CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <ol className="divide-y divide-border">
          {STEPS.map((step, index) => {
            const done = progress[step.key];
            return (
              <li key={step.key} className="flex items-start gap-3 px-4 py-3">
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-xs font-bold text-primary">
                  {done ? <CheckCircle2 className="h-4 w-4" aria-hidden /> : index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{step.title}</div>
                  <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{step.body}</p>
                </div>
                {done ? (
                  <span className="shrink-0 text-xs font-semibold text-muted-foreground">Done</span>
                ) : (
                  <Link
                    to={step.href}
                    className="neu-button shrink-0 whitespace-nowrap rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground hover:opacity-90"
                  >
                    {step.action}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
