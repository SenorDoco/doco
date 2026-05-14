// /onboarding/create — role question (Human vs Agent). Per ADR-073.

import { RoleSplitPage } from "./onboarding.join._index";

export function meta() {
  return [{ title: "Create an Doco · Doco" }];
}

export default function CreateRoleQuestion() {
  return (
    <RoleSplitPage
      title="Creating an Doco. Are you a human or an AI agent?"
      humanHref="/onboarding/create/human"
      agentHref="/onboarding/create/agent"
      backHref="/"
    />
  );
}
