// /onboarding/create — role question (Human vs Agent). Per ADR-073.
// The "Agent" leaf points straight at /onboarding/create/agent.txt
// (plain text). An agent that picks the agent tile lands on the
// instructions in the form they prefer; no HTML page to render in
// between. reloadDocument is set because .txt is a resource route
// (loader-only, no default export).

import { RoleSplitPage } from "./onboarding.join._index";

export function meta() {
  return [{ title: "Create a doco · Doco" }];
}

export default function CreateRoleQuestion() {
  return (
    <RoleSplitPage
      title="Creating a doco. Choose who is setting it up."
      humanHref="/onboarding/create/human"
      agentHref="/onboarding/create/agent.txt"
      agentReloadDocument
      backHref="/"
    />
  );
}
