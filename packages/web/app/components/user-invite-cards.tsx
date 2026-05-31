import { useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import { GrantPicker } from "~/components/grant-picker";
import {
  type ComposedGrant,
  type DocoRole,
  catalogFromOptions,
  resolveWriteTypes,
} from "~/lib/grant-picker";
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
  // Collaborators are people. Agents are not invited from here: they
  // authenticate through API tokens, so this card only mints person
  // invites and points owners at the API Tokens page for agents.
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold" data-testid="invite-person-title">
        Invite a person
      </h2>
      <InviteHumanCard
        orgs={invite.orgs}
        docos={invite.docos}
        defaultSelection={invite.defaultSelection}
      />
      <p className="text-sm text-muted-foreground">
        Adding an AI agent instead?{" "}
        <a
          href="/api-keys"
          data-testid="invite-agent-link"
          className="font-semibold text-primary underline-offset-4 hover:underline"
        >
          Invite an agent from the API Tokens page →
        </a>
      </p>
    </div>
  );
}

function InviteHumanCard({
  orgs,
  docos,
  defaultSelection,
}: {
  orgs: { id: string; label: string; maxRole: DocoRole }[];
  docos: { id: string; label: string; maxRole: DocoRole; orgId?: string }[];
  defaultSelection: InviteDefaultSelection;
}) {
  const fetcher = useFetcher<UserInviteActionResult>();
  const result = fetcher.data;
  const inviteResult = result && "intent" in result && result.intent === "invite" ? result : null;
  const error = result && "error" in result ? result.error : undefined;

  const catalog = useMemo(() => catalogFromOptions(orgs, docos), [orgs, docos]);
  // Pre-select the target the page linked to (?scope=level:id), as a reader
  // grant the user can then widen in the picker.
  const initial = useMemo<ComposedGrant | null>(() => {
    const t = catalog.targets.find(
      (x) => x.level === defaultSelection.level && x.id === defaultSelection.targetId,
    );
    return t ? { level: t.level, targetId: t.id, role: "reader", writeTypes: [] } : null;
  }, [catalog, defaultSelection]);
  const [grant, setGrant] = useState<ComposedGrant | null>(initial);

  const noTargets = catalog.targets.length === 0;
  const writeTypes = grant ? resolveWriteTypes(grant.role, grant.writeTypes) : [];

  return (
    <div className="space-y-3">
      <fetcher.Form method="post" className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="invite" />
        <input type="hidden" name="level" value={grant?.level ?? ""} />
        <input type="hidden" name="target_id" value={grant?.targetId ?? ""} />
        <input type="hidden" name="role" value={grant?.role ?? ""} />
        <input type="hidden" name="write_types" value={writeTypes.join(",")} />
        <GrantPicker catalog={catalog} value={grant} onChange={setGrant} />
        <div className="flex justify-end">
          <button
            type="submit"
            data-testid="invite-submit"
            disabled={fetcher.state !== "idle" || noTargets || !grant}
            className="neu-button bg-primary text-primary-foreground hover:opacity-90 rounded-md px-4 py-2 text-sm font-semibold disabled:opacity-50"
          >
            {fetcher.state !== "idle" ? "Generating..." : "Generate invite link"}
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
