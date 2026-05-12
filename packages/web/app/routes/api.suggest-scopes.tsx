// Resource route: POST /api/suggest-scopes
//
// Server-side LLM call that takes a project description + existing scope
// names and returns proposed scopes. Used by /scopes/new (host mode) to
// help the user/agent prepopulate scopes that match what they're actually
// documenting, instead of blindly checking all 8 templates.
//
// ADR-082 follow-up. Returns [] when OPENAI_API_KEY is missing.
import { suggestScopes } from "~/lib/redeem.server";

export async function action({ request }: { request: Request }) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  const body = (await request.json().catch(() => ({}))) as {
    description?: string;
    existingScopeNames?: string[];
    templateNames?: string[];
  };
  if (!body.description || body.description.trim().length < 5) {
    return Response.json({ suggestions: [] });
  }
  const suggestions = await suggestScopes({
    description: body.description,
    existingScopeNames: body.existingScopeNames,
    templateNames: body.templateNames,
  });
  return Response.json({ suggestions });
}

// No GET / loader — POST-only resource route.
export function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}
