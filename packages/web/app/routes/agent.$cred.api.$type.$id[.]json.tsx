import { dispatchAgentUrl } from "~/lib/agent-redirect.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { cred: string; type: string; id: string };
}) {
  return dispatchAgentUrl({
    request,
    cred: params.cred ?? "",
    rest: `api/${params.type}/${params.id}.json`,
  });
}

export const action = loader;
