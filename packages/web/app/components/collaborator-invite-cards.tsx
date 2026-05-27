import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import { AgentInvitePrompt } from "~/components/agent-invite-prompt";
import { CollaborationInvitePrompt } from "~/components/collaboration-invite-prompt";
import {
  ALL_ROLES,
  type CollaboratorInviteActionResult,
  type CollaboratorInviteData,
  type InviteDefaultSelection,
  type InviteLevel,
  rankOf,
} from "~/lib/collaborator-invite";

interface CombinedTargetOption {
  key: string; // "<level>:<id>"
  level: InviteLevel;
  id: string;
  label: string;
  maxRole: (typeof ALL_ROLES)[number];
}

function buildCombinedOptions(
  orgs: { id: string; label: string; maxRole: (typeof ALL_ROLES)[number] }[],
  docos: { id: string; label: string; maxRole: (typeof ALL_ROLES)[number] }[],
): CombinedTargetOption[] {
  const out: CombinedTargetOption[] = [
    ...orgs.map<CombinedTargetOption>((o) => ({
      key: `org:${o.id}`,
      level: "org",
      id: o.id,
      label: o.label,
      maxRole: o.maxRole,
    })),
    ...docos.map<CombinedTargetOption>((d) => ({
      key: `doco:${d.id}`,
      level: "doco",
      id: d.id,
      label: d.label,
      maxRole: d.maxRole,
    })),
  ];
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

export function CollaboratorInviteCards({
  invite,
  host,
}: {
  invite: CollaboratorInviteData;
  host: string;
}) {
  const [mode, setMode] = useState<"person" | "agent">("person");
  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Collaborator invite type"
        className="inline-flex rounded-md border border-border bg-background p-0.5"
      >
        <InviteModeButton mode="person" current={mode} onSelect={setMode}>
          Invite a person
        </InviteModeButton>
        <InviteModeButton mode="agent" current={mode} onSelect={setMode}>
          Invite an agent
        </InviteModeButton>
      </div>

      {mode === "person" ? (
        <InviteHumanCard
          orgs={invite.orgs}
          docos={invite.docos}
          defaultSelection={invite.defaultSelection}
        />
      ) : (
        <AgentInvitePrompt
          host={host}
          promptTestId="collaborators-invite-agent-prompt"
          copyButtonTestId="collaborators-invite-agent-copy"
        />
      )}
    </div>
  );
}

function InviteModeButton({
  mode,
  current,
  onSelect,
  children,
}: {
  mode: "person" | "agent";
  current: "person" | "agent";
  onSelect: (mode: "person" | "agent") => void;
  children: ReactNode;
}) {
  const active = mode === current;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(mode)}
      className={
        active
          ? "rounded-md bg-primary px-3 py-1.5 text-base font-semibold text-primary-foreground"
          : "rounded-md px-3 py-1.5 text-base font-semibold text-muted-foreground hover:text-foreground"
      }
    >
      {children}
    </button>
  );
}

function InviteHumanCard({
  orgs,
  docos,
  defaultSelection,
}: {
  orgs: { id: string; label: string; maxRole: (typeof ALL_ROLES)[number] }[];
  docos: { id: string; label: string; maxRole: (typeof ALL_ROLES)[number] }[];
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
  const allowedRoles = selected
    ? ALL_ROLES.filter((role) => rankOf(role) <= rankOf(selected.maxRole))
    : [];
  const defaultRole =
    selected && rankOf(selected.maxRole) >= rankOf("author") ? "author" : selected?.maxRole;

  return (
    <div className="space-y-3">
      <fetcher.Form method="post" className="flex flex-col gap-3">
        <input type="hidden" name="intent" value="invite" />
        <input type="hidden" name="level" value={selected?.level ?? ""} />
        <input type="hidden" name="target_id" value={selected?.id ?? ""} />
        <div className="flex flex-wrap items-end justify-start gap-3">
          <label className="flex flex-col gap-1 text-sm">
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
              defaultValue={defaultRole ?? ""}
              key={selectedKey}
              data-testid="invite-role"
              className="rounded-md px-3 py-2"
            >
              {allowedRoles.map((r) => (
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
    </div>
  );
}
