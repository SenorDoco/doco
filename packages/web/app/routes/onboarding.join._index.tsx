// /onboarding/join — role question (Human vs Agent). Per ADR-073.
import { Link } from "react-router";
import { getMode } from "~/lib/db";
import { loadHostConfig } from "~/lib/host";
import { DocoMark } from "~/components/doco-mark";

export function loader() {
  if (getMode() !== "host") throw new Response("Host mode only.", { status: 404 });
  return { host: loadHostConfig() };
}

export function meta() {
  return [{ title: "Join an Doco · Doco" }];
}

export default function JoinRoleQuestion({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  return (
    <RoleSplitPage
      hostName={loaderData.host.name}
      title="Joining an Doco. Are you a human or an AI agent?"
      humanHref="/onboarding/join/human"
      agentHref="/onboarding/join/agent"
      backHref="/"
    />
  );
}

export function RoleSplitPage({
  hostName,
  title,
  humanHref,
  agentHref,
  backHref,
}: {
  hostName: string;
  title: string;
  humanHref: string;
  agentHref: string;
  backHref: string;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <Link to="/" className="inline-flex items-center hover:opacity-80" aria-label="Doco home">
            <DocoMark height={28} />
          </Link>
          <Link to={backHref} className="text-xs text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="flex max-w-2xl flex-col items-center gap-8 text-center">
          <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
          <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
            <Link
              to={humanHref}
              className="rounded-lg border border-border bg-card px-6 py-8 text-left transition-colors hover:border-primary"
            >
              <div className="text-base font-semibold">I'm a human</div>
              <div className="mt-2 text-xs text-muted-foreground">
                A person reading this page in a browser.
              </div>
            </Link>
            <Link
              to={agentHref}
              className="rounded-lg border border-border bg-card px-6 py-8 text-left transition-colors hover:border-primary"
            >
              <div className="text-base font-semibold">I'm an AI agent</div>
              <div className="mt-2 text-xs text-muted-foreground">
                An LLM, autonomous tool, or any non-human reading this page.
              </div>
            </Link>
          </div>
          <p className="pt-4 text-[11px] text-muted-foreground">
            Hosted by <span className="font-semibold">{hostName}</span>
          </p>
        </div>
      </main>
    </div>
  );
}
