// /onboarding/create — role question (Human vs Agent). Per ADR-073.
// Updated by decision_01KRKZM14WNA1685GN0F12WCKM: the "Agent" leaf now
// points at /onboarding/create/agent, which is an info-only page that
// tells agents to run `doco login --create <slug>` from the project
// root. No HTTP-POST "create an unclaimed Doco" form.

import { RoleSplitPage } from "./onboarding.join._index";

export function meta() {
  return [{ title: "Create an Doco · Doco" }];
}

export default function CreateRoleQuestion() {
  return (
    <RoleSplitPage
      title="Creating a Doco. Are you a human or an AI agent?"
      humanHref="/onboarding/create/human"
      agentHref="/onboarding/create/agent"
      backHref="/"
    />
  );
}
