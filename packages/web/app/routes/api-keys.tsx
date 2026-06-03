// /api-keys — legacy path. The Tokens/MCP page moved to /tokens; this shim
// 302-redirects there so old links, bookmarks, the navbar shortcut, and the
// historical agent-OAuth-recipe URL keep working. The query string rides along
// (e.g. ?tab=mcp). The JSON API at /api/v1/api-keys.json is unaffected — that
// endpoint keeps its name for API consumers.
import { redirect } from "react-router";

function redirectToTokens(request: Request): never {
  const url = new URL(request.url);
  throw redirect(`/tokens${url.search}`);
}

export async function loader({ request }: { request: Request }) {
  return redirectToTokens(request);
}

export async function action({ request }: { request: Request }) {
  return redirectToTokens(request);
}
