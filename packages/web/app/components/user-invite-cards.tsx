import { useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import { GrantPicker } from "~/components/grant-picker";
import { focusFirstError, validateGrantForm } from "~/lib/grant-form-validation";
import { type ComposedGrant, type DocoRole, catalogFromOptions } from "~/lib/grant-picker";
import type {
  InviteDefaultSelection,
  UserInviteActionResult,
  UserInviteData,
} from "~/lib/user-invite";

export function UserInviteCards({
  invite,
}: {
  invite: UserInviteData;
}) {
  // Collaborators have their own digital identity. Traditional agents
  // authenticate through tokens/MCP, so this card points owners there.
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold" data-testid="invite-person-title">
        Invite a person or agent with their own digital identity
      </h2>
      <InviteHumanCard
        workspaces={invite.workspaces}
        docos={invite.docos}
        defaultSelection={invite.defaultSelection}
      />
      <p className="text-sm text-muted-foreground">
        Adding a traditional AI agent instead?{" "}
        <a
          href="/api-keys"
          data-testid="invite-agent-link"
          className="font-semibold text-primary underline-offset-4 hover:underline"
        >
          Connect to Doco&apos;s MCP →
        </a>
      </p>
    </div>
  );
}

function InviteHumanCard({
  workspaces,
  docos,
  defaultSelection,
}: {
  workspaces: { id: string; label: string; maxRole: DocoRole }[];
  docos: { id: string; label: string; maxRole: DocoRole; workspaceId?: string }[];
  defaultSelection: InviteDefaultSelection;
}) {
  const fetcher = useFetcher<UserInviteActionResult>();
  const result = fetcher.data;
  const inviteResult = result && "intent" in result && result.intent === "invite" ? result : null;
  const error = result && "error" in result ? result.error : undefined;

  const catalog = useMemo(() => catalogFromOptions(workspaces, docos), [workspaces, docos]);
  // The deep-link (?scope=level:id) is now just a hint; the wizard starts
  // empty and the granter builds up one or more grants.
  void defaultSelection;
  const [grants, setGrants] = useState<ComposedGrant[]>([]);
  const [grantError, setGrantError] = useState<string | null>(null);
  const grantsRef = useRef<HTMLDivElement>(null);

  const noTargets = catalog.targets.length === 0;

  // Submit stays clickable so clicking with nothing selected explains itself
  // instead of doing nothing.
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    const found = validateGrantForm({ grantCount: grants.length });
    if (found.length === 0) {
      setGrantError(null);
      return;
    }
    e.preventDefault();
    setGrantError(found[0].message);
    focusFirstError("grants", { grants: grantsRef.current });
  }

  return (
    <div className="space-y-3">
      <fetcher.Form method="post" onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="invite" />
        {/* One invite link, all selected grants (decision: one-link-all-grants). */}
        <input type="hidden" name="grants" value={JSON.stringify(grants)} />
        <div ref={grantsRef}>
          <GrantPicker
            catalog={catalog}
            grants={grants}
            onChange={(next) => {
              setGrants(next);
              if (next.length > 0) setGrantError(null);
            }}
          />
          {grantError ? (
            <p role="alert" className="mt-2 text-xs text-destructive">
              {grantError}
            </p>
          ) : null}
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            data-testid="invite-submit"
            disabled={fetcher.state !== "idle" || noTargets}
            className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {fetcher.state !== "idle"
              ? "Generating..."
              : `Generate invite link${grants.length > 1 ? ` (${grants.length} grants)` : ""}`}
          </button>
        </div>
      </fetcher.Form>

      {error ? (
        <p className="text-sm text-destructive" data-testid="invite-error">
          {error}
        </p>
      ) : null}

      {inviteResult ? (
        <CollaborationInvitePrompt
          inviteUrl={inviteResult.invite_url}
          testId="invite-result"
          promptTestId="invite-url"
          copyButtonTestId="invite-copy"
          note={
            <>
              Single-use, expires in 72 hours. Grants <strong>{inviteResult.role}</strong> at the{" "}
              {inviteResult.level} level.
            </>
          }
        />
      ) : null}
    </div>
  );
}
