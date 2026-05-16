import { dispatchAgentUrl } from "~/lib/agent-redirect.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { cred: string };
}) {
  return dispatchAgentUrl({ request, cred: params.cred ?? "", rest: "search.json" });
}

export const action = loader;
