// The steps that get a workspace going, on top of its page until every one is
// done: connect GitHub, connect other sources of knowledge (or skip them),
// connect Doco to your agent, ask your agent to start using Doco, turn on the
// Doco hook (or skip it). Someone who joined from an invite only has the two
// about their agent. The page keeps the person on the first step not done.
// Connecting GitHub goes through the GitHub setup
// (routes/integrations.github.tsx), which asks which repositories to bring;
// the other sources are one click each
// (routes/workspaces.$workspaceHandle.onboarding.tsx) and come back here
// saying what happened. The last three wait in view for what happens in the
// agent: the person approving its connection to Doco, its note in the
// workspace's Agents chats Doco, then the hook's first brief with the project
// token the step creates.

import { CheckCircle2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useFetcher, useRevalidator, useSearchParams } from "react-router";
import { AgentInstructionsBlock } from "~/components/agent-instructions-block";
import { BRAND_ICONS, GitHubIcon } from "~/components/brand-icons";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { ConnectAgentGuide } from "~/components/connect-agent-guide";
import { DocoTypeIcon } from "~/components/doco-type-icon";
import { cn } from "~/lib/cn";
import { GITHUB_IMPORTS } from "~/lib/github-imports";
import { type OnboardingStep, STEP_TITLES } from "~/lib/onboarding-steps";
import type { OnboardingView } from "~/lib/onboarding-view.server";

const PRIMARY =
  "neu-button inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:opacity-90";
const SECONDARY =
  "neu-button inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-semibold";

/** Why a step's click came back without doing it (`?onboarding=<reason>`). */
const REFUSALS: Record<string, string> = {
  not_owner: "Only an owner of this workspace can take this step.",
  github_unavailable: "GitHub isn't set up on this host, so Doco can't connect it.",
  source_unavailable: "That source isn't set up on this host, so Doco can't connect it.",
  source_public:
    "Make the source's Doco private first: a copy of a team's Slack or Notion is never public.",
  unconfirmed:
    "Check the box first: anyone who can read the repository where the token is saved will read every Doco in this workspace.",
  unknown: "That didn't work. Try again.",
};

/** How often a step waiting on the agent asks whether it has moved on. */
const AGENT_POLL_MS = 4000;

export function OnboardingStepper({ view }: { view: OnboardingView }) {
  const [searchParams] = useSearchParams();
  const refusal = REFUSALS[searchParams.get("onboarding") ?? ""];
  const [finished, setFinished] = useState(false);
  const creator = view.joinedAs === "creator";

  if (finished) return <AllSet view={view} />;

  return (
    <Card aria-label={`Set up ${view.workspaceHandle}`}>
      <CardHeader>
        <CardTitle>
          {creator ? `Set up ${view.workspaceHandle}` : `Get started in ${view.workspaceHandle}`}
        </CardTitle>
        <CardDescription>
          {creator
            ? "Five steps to shared knowledge and context for your team and its agents."
            : `You joined ${view.workspaceHandle}. Two steps left: connect Doco to your agent, then ask it to start using Doco here.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 p-0">
        {refusal ? (
          <p className="mx-5 rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
            {refusal}
          </p>
        ) : null}
        <ol className="divide-y divide-border border-t border-border">
          {view.steps.map(({ step, done }, index) => (
            <StepRow
              key={step}
              number={index + 1}
              step={step}
              done={done}
              current={step === view.pending}
            >
              {step === view.pending ? (
                <StepBody step={step} view={view} onFinished={() => setFinished(true)} />
              ) : done ? (
                <DoneSummary step={step} view={view} />
              ) : null}
            </StepRow>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function StepRow({
  number,
  step,
  done,
  current,
  children,
}: {
  number: number;
  step: OnboardingStep;
  done: boolean;
  current: boolean;
  children: React.ReactNode;
}) {
  return (
    <li
      aria-current={current ? "step" : undefined}
      className={cn("flex items-start gap-3 px-5 py-4", !done && !current && "opacity-60")}
    >
      <span
        className={cn(
          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold",
          current
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border text-primary",
        )}
      >
        {done ? <CheckCircle2 className="h-4 w-4" aria-label="Done" /> : number}
      </span>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className={cn("text-sm font-semibold", current && "text-base")}>
            {STEP_TITLES[step]}
          </h3>
          {done ? (
            <span className="shrink-0 text-xs font-semibold text-muted-foreground">Done</span>
          ) : null}
        </div>
        {children}
      </div>
    </li>
  );
}

function StepBody({
  step,
  view,
  onFinished,
}: {
  step: OnboardingStep;
  view: OnboardingView;
  onFinished: () => void;
}) {
  const action = `/workspaces/${view.workspaceHandle}/onboarding`;
  if (step === "github") return <GitHubStep view={view} />;
  if (step === "sources") return <SourcesStep view={view} action={action} />;
  if (step === "mcp") return <McpStep view={view} action={action} onFinished={onFinished} />;
  if (step === "agent") return <AgentStep view={view} action={action} onFinished={onFinished} />;
  return <HookStep view={view} action={action} onFinished={onFinished} />;
}

/**
 * Ask where the steps stand every few seconds while one waits on the agent,
 * and move on the moment it does: to the next step, or to all set.
 */
function useWaitForAgent(view: OnboardingView, action: string, onFinished: () => void) {
  const fetcher = useFetcher<{ pending: OnboardingStep | null }>();
  const revalidator = useRevalidator();

  const load = fetcher.load;
  useEffect(() => {
    const timer = setInterval(() => load(action), AGENT_POLL_MS);
    return () => clearInterval(timer);
  }, [load, action]);

  const pending = fetcher.data?.pending;
  const revalidate = revalidator.revalidate;
  useEffect(() => {
    if (pending === undefined || pending === view.pending) return;
    if (pending === null) onFinished();
    else revalidate();
  }, [pending, view.pending, onFinished, revalidate]);
}

function Waiting({ children }: { children: React.ReactNode }) {
  return (
    <output className="flex items-center gap-2 text-xs text-muted-foreground">
      <span
        aria-hidden
        className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
      />
      <span>{children}</span>
    </output>
  );
}

function GitHubStep({ view }: { view: OnboardingView }) {
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Brings what your code knows into Docos of its own, kept in sync as it changes:
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5">
        {GITHUB_IMPORTS.map((i) => (
          <li key={i.id} className="flex items-center gap-1.5 text-xs font-semibold">
            <DocoTypeIcon template={i.template} className="text-muted-foreground" />
            {i.label}
          </li>
        ))}
      </ul>
      {view.github.available ? (
        <>
          <Form method="post" action="/integrations/github">
            <input type="hidden" name="intent" value="choose" />
            <input type="hidden" name="workspace" value={view.workspaceHandle} />
            {GITHUB_IMPORTS.map((i) => (
              <input key={i.id} type="hidden" name="bring" value={i.id} />
            ))}
            <button type="submit" className={PRIMARY}>
              <GitHubIcon className="h-3.5 w-3.5" aria-hidden />
              Connect GitHub
            </button>
          </Form>
          <p className="text-xs text-muted-foreground">
            Next you choose the repositories to bring: every repository in an organization, or only
            the ones you pick. Nothing comes over until you pick. If Doco can&apos;t reach your
            GitHub yet, GitHub asks you to approve it first.
          </p>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">{REFUSALS.github_unavailable}</p>
      )}
    </div>
  );
}

function SourcesStep({ view, action }: { view: OnboardingView; action: string }) {
  const anyConnected = view.sources.some((s) => s.connected);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Bring in what your team already knows. Each source comes into a private Doco of its own,
        kept in sync. Connect as many as you like, or skip this step.
      </p>
      <ul className="space-y-2">
        {view.sources.map((source) => {
          const Icon = BRAND_ICONS[source.id];
          return (
            <li
              key={source.id}
              className="neu-well flex flex-wrap items-center gap-3 rounded-md p-3 sm:flex-nowrap"
            >
              {Icon ? <Icon className="h-5 w-5 shrink-0" /> : null}
              <div className="min-w-0 flex-1 basis-48">
                <div className="font-semibold">{source.name}</div>
                <p className="text-xs text-muted-foreground">{source.description}</p>
              </div>
              {source.connected ? (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Connected, copying into{" "}
                  <Link to={`/${source.docoHandle}`} className="font-mono">
                    {source.docoHandle}
                  </Link>
                </span>
              ) : source.available ? (
                <Form method="post" action={action} className="shrink-0">
                  <input type="hidden" name="intent" value="source" />
                  <input type="hidden" name="integration" value={source.id} />
                  <button type="submit" className={PRIMARY}>
                    Connect {source.name}
                  </button>
                </Form>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Not set up on this host
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="text-[11px] text-muted-foreground">
        Connecting authorizes Doco to store and sync a copy, which its AI providers process under
        terms that exclude training on it. Slack copies public channels only and needs a Slack admin
        or owner to approve; in Notion you pick the pages to share.
      </p>
      <Form method="post" action={action}>
        <input type="hidden" name="intent" value="finish-sources" />
        <button type="submit" className={anyConnected ? PRIMARY : SECONDARY}>
          {anyConnected ? "Continue" : "Skip for now"}
        </button>
      </Form>
    </div>
  );
}

function McpStep({
  view,
  action,
  onFinished,
}: {
  view: OnboardingView;
  action: string;
  onFinished: () => void;
}) {
  useWaitForAgent(view, action, onFinished);
  return (
    <div className="space-y-4 text-sm">
      <p className="text-muted-foreground">
        Add Doco to the agent you use, so it can read and write in {view.workspaceHandle}. When Doco
        asks what the agent may reach, include {view.workspaceHandle}.
      </p>
      <ConnectAgentGuide guides={view.mcp.guides} />
      <Waiting>
        Waiting for you to approve Doco from your agent. This page moves on by itself once you do.
      </Waiting>
    </div>
  );
}

function AgentStep({
  view,
  action,
  onFinished,
}: {
  view: OnboardingView;
  action: string;
  onFinished: () => void;
}) {
  useWaitForAgent(view, action, onFinished);
  const where = view.agent.agentsChatsHandle ?? `${view.workspaceHandle}'s Agents chats Doco`;
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        Copy this message and send it to your agent. It has your agent start using Doco in{" "}
        {view.workspaceHandle} and note in{" "}
        <span className="font-mono text-foreground">{where}</span> that it received the
        instructions. That note finishes this step.
      </p>
      <AgentInstructionsBlock
        title="Message for your agent"
        instructions={view.agent.instructions}
      />
      <Waiting>
        Waiting for your agent to write in <span className="font-mono">{where}</span>. This page
        moves on by itself once it does.
      </Waiting>
    </div>
  );
}

function HookStep({
  view,
  action,
  onFinished,
}: {
  view: OnboardingView;
  action: string;
  onFinished: () => void;
}) {
  useWaitForAgent(view, action, onFinished);
  const fetcher = useFetcher<{ message: string }>();
  const message = fetcher.data?.message;
  const skip = (
    <button type="submit" name="intent" value="finish-hook" formNoValidate className={SECONDARY}>
      My agent doesn&apos;t run hooks
    </button>
  );
  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground">
        The Doco hook briefs your agent from {view.workspaceHandle} before each prompt and each file
        edit, so it acts on what your team already decided. It runs in Claude Code, Codex and Gemini
        CLI, and your agent installs it from the message in step 4. It reads {view.workspaceHandle}{" "}
        with a project token, which only an owner can create.
      </p>
      {message ? (
        <>
          <AgentInstructionsBlock title="Message for your agent" instructions={message} />
          <p className="text-xs text-muted-foreground">
            The token is shown only here, once. Revoke it any time from the workspace&apos;s{" "}
            <Link to={`/workspaces/${view.workspaceHandle}/project-tokens`}>project tokens</Link>.
          </p>
          <Waiting>
            Waiting for the hook&apos;s first brief. Once your agent saves the token, send it
            another message, or start a new session if it just installed the hook. This page moves
            on by itself.
          </Waiting>
          <fetcher.Form method="post" action={action}>
            {skip}
          </fetcher.Form>
        </>
      ) : (
        <fetcher.Form method="post" action={action} className="space-y-3">
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" name="confirm_repo_readable" required className="mt-0.5" />
            <span>
              Anyone who can read the repository where the token is saved will be able to read every
              Doco in {view.workspaceHandle}.
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              name="intent"
              value="hook-token"
              disabled={fetcher.state !== "idle"}
              className={PRIMARY}
            >
              Create project token
            </button>
            {skip}
          </div>
        </fetcher.Form>
      )}
    </div>
  );
}

function DoneSummary({ step, view }: { step: OnboardingStep; view: OnboardingView }) {
  if (step === "github" && view.github.docos.length > 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Importing into{" "}
        {view.github.docos.map((d, i) => (
          <span key={d.handle}>
            {i > 0 ? (i === view.github.docos.length - 1 ? " and " : ", ") : null}
            <Link to={`/${d.handle}`} className="font-mono">
              {d.handle}
            </Link>
          </span>
        ))}
        , each showing how far it has got.
      </p>
    );
  }
  if (step === "sources") {
    const connected = view.sources.filter((s) => s.connected).map((s) => s.name);
    return (
      <p className="text-xs text-muted-foreground">
        {connected.length > 0
          ? `Connected ${new Intl.ListFormat("en", { type: "conjunction" }).format(connected)}.`
          : "No other sources connected. Connect them any time from App integrations."}
      </p>
    );
  }
  return null;
}

function AllSet({ view }: { view: OnboardingView }) {
  const revalidator = useRevalidator();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-primary" aria-hidden />
          {view.workspaceHandle} is set up
        </CardTitle>
        <CardDescription>
          Your agent is working in Doco: it loads the workspace&apos;s context before it answers and
          records what it decides.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <button type="button" className={PRIMARY} onClick={() => revalidator.revalidate()}>
          Go to {view.workspaceHandle}
        </button>
      </CardContent>
    </Card>
  );
}
