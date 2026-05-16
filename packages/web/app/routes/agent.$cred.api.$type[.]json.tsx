import { dispatchAgentUrl } from "~/lib/agent-redirect.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { cred: string; type: string };
}) {
  return dispatchAgentUrl({
    request,
    cred: params.cred ?? "",
    rest: `api/${params.type}.json`,
  });
}

export const action = loader;
