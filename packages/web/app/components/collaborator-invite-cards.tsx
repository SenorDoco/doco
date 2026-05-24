import { useEffect, useMemo, useState } from "react";
import { Link, useFetcher } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import {
  ALL_ROLES,
  type CollaboratorInviteActionResult,
  type CollaboratorInviteData,
  type InviteDefaultSelection,
  type InviteLevel,
} from "~/lib/collaborator-invite";

interface CombinedTargetOption {
  key: string; // "<level>:<id>"
  level: InviteLevel;
  id: string;
  label: string;
}

function buildCombinedOptions(
  orgs: { id: string; label: string }[],
  docos: { id: string; label: string }[],
): CombinedTargetOption[] {
  const out: CombinedTargetOption[] = [
    ...orgs.map<CombinedTargetOption>((o) => ({
      key: `org:${o.id}`,
      level: "org",
      id: o.id,
      label: o.label,
    })),
    ...docos.map<CombinedTargetOption>((d) => ({
      key: `doco:${d.id}`,
      level: "doco",
      id: d.id,
      label: d.label,
    })),
  ];
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

export function CollaboratorInviteCards({
  invite,
}: {
  invite: CollaboratorInviteData;
}) {
  return (
    <div className="space-y-4">
      <InviteHumanCard
        orgs={invite.orgs}
        docos={invite.docos}
        defaultSelection={invite.defaultSelection}
      />
      <AgentRedirectCard />
    </div>
  );
}

function InviteHumanCard({
  orgs,
  docos,
  defaultSelection,
}: {
  orgs: { id: string; label: string }[];
  docos: { id: string; label: string }[];
  defaultSelection: InviteDefaultSelection;
}) {
  const fetcher = useFetcher<CollaboratorInviteActionResult>();
  const result = fetcher.data;
  const inviteResult = result && "intent" in result && result.intent === "invite" ? result : null;
  const error = result && "error" in result ? result.error : undefined;

  const combinedOptions = useMemo(() => buildCombinedOptions(orgs, docos), [orgs, docos]);
  const defaultKey = `${defaultSelection.level}:${defaultSelection.targetId}`;
  const initialSelected = combinedOptions.some((o) => o.key === defaultKey)
    ? defaultKey
    : (combinedOptions[0]?.key ?? "");
  const [selectedKey, setSelectedKey] = useState(initialSelected);
  const noTargets = combinedOptions.length === 0;

  useEffect(() => {
    if (noTargets) {
      if (selectedKey !== "") setSelectedKey("");
      return;
    }
    if (!combinedOptions.some((opt) => opt.key === selectedKey)) {
      setSelectedKey(combinedOptions[0]?.key ?? "");
    }
  }, [combinedOptions, noTargets, selectedKey]);

  const selected = combinedOptions.find((o) => o.key === selectedKey);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invite a human</CardTitle>
        <CardDescription>
          They click the URL, sign in with GitHub, and land in your Doco with the exact role you
          pick.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <fetcher.Form method="post" className="flex flex-col gap-3">
          <input type="hidden" name="intent" value="invite" />
          <input type="hidden" name="level" value={selected?.level ?? ""} />
          <input type="hidden" name="target_id" value={selected?.id ?? ""} />
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-1 flex-col gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Org / Doco
              </span>
              <select
                value={selectedKey}
                onChange={(e) => setSelectedKey(e.currentTarget.value)}
                disabled={noTargets}
                data-testid="invite-target"
                className="rounded-md px-3 py-2 disabled:opacity-50"
              >
                {noTargets ? (
                  <option value="">(no targets you can invite into)</option>
                ) : (
                  combinedOptions.map((opt) => (
                    <option key={opt.key} value={opt.key}>
                      [{opt.level}] {opt.label}
                    </option>
                  ))
                )}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">Role</span>
              <select
                name="role"
                defaultValue="author"
                data-testid="invite-role"
                className="rounded-md px-3 py-2"
              >
                {ALL_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end">
            <button
              type="submit"
              data-testid="invite-submit"
              disabled={fetcher.state !== "idle" || noTargets}
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
      </CardContent>
    </Card>
  );
}

function AgentRedirectCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Looking to add an AI agent?</CardTitle>
        <CardDescription>
          Agents authenticate via OAuth and don't redeem an invite URL. Mint an API key on the API
          keys page — it's bound to your account and you pick which orgs / docos it can reach.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Link
          to="/api-keys"
          data-testid="invite-agent-redirect"
          className="neu-button bg-primary text-primary-foreground hover:opacity-90 inline-flex rounded-md px-3 py-1.5 text-xs font-semibold"
        >
          Go to API keys →
        </Link>
      </CardContent>
    </Card>
  );
}
