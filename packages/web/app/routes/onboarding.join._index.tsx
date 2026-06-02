// /onboarding/join — role question (Human vs Agent). Per ADR-073.
import { Link } from "react-router";
import { Breadcrumb } from "~/components/breadcrumb";

import { DocoMark } from "~/components/doco-mark";
import { VersionPill } from "~/components/version-pill";

export function meta() {
  return [{ title: "Join a workspace · Doco" }];
}

export default function JoinRoleQuestion() {
  return (
    <RoleSplitPage
      title="Joining a workspace. Choose who is joining."
      humanHref="/onboarding/join/human"
      agentHref="/onboarding/join/agent"
      backHref="/"
    />
  );
}

export function RoleSplitPage({
  title,
  humanHref,
  agentHref,
  agentReloadDocument = false,
  backHref,
}: {
  title: string;
  humanHref: string;
  agentHref: string;
  /** Set when agentHref targets a resource route (.txt / .json) — forces a
   *  full browser navigation instead of react-router client-side routing. */
  agentReloadDocument?: boolean;
  backHref: string;
}) {
  return (
    <div className="min-h-screen flex flex-col">
      <header>
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-3">
          <div className="flex items-center gap-3">
            <Link
              to="/"
              className="inline-flex items-center hover:opacity-80"
              aria-label="Doco home"
            >
              <DocoMark height={28} />
            </Link>
            <VersionPill />
          </div>
          <Link to={backHref} className="text-xs text-muted-foreground hover:text-foreground">
            ← Back
          </Link>
        </div>
      </header>
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-16">
        <div className="flex max-w-2xl flex-col items-center gap-8 text-center">
          <Breadcrumb items={[{ label: "Home", to: "/" }, { label: "Join a doco" }]} />
          <h1 className="text-lg font-bold tracking-tight">{title}</h1>
          <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-2 md:gap-4">
            <Link
              to={humanHref}
              className="neu-surface-interactive rounded-lg bg-card px-6 py-8 text-left transition-colors hover:border-primary"
            >
              <div className="text-base font-semibold">You are human</div>
              <div className="mt-2 text-xs text-muted-foreground">
                A person reading this page in a browser.
              </div>
            </Link>
            <Link
              to={agentHref}
              reloadDocument={agentReloadDocument}
              className="neu-surface-interactive rounded-lg bg-card px-6 py-8 text-left transition-colors hover:border-primary"
            >
              <div className="text-base font-semibold">You are an AI agent</div>
              <div className="mt-2 text-xs text-muted-foreground">
                An LLM, autonomous tool, or any non-human reading this page.
              </div>
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
