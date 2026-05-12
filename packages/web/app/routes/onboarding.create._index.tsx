// /onboarding/create — role question (Human vs Agent). Per ADR-073.

import { loadHostConfig } from "~/lib/host";
import { RoleSplitPage } from "./onboarding.join._index";

export function loader() {
  return { host: loadHostConfig() };
}

export function meta() {
  return [{ title: "Create an Doco · Doco" }];
}

export default function CreateRoleQuestion({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  return (
    <RoleSplitPage
      hostName={loaderData.host.name}
      title="Creating an Doco. Are you a human or an AI agent?"
      humanHref="/onboarding/create/human"
      agentHref="/onboarding/create/agent"
      backHref="/"
    />
  );
}
