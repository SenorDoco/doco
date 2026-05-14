import { getPublicBaseUrl } from "@doco/shared";
import { createDocoAsAgentFromForm } from "~/lib/onboarding-create-agent.server";

/**
 * /onboarding/create/agent.json — agent-optimized POST endpoint.
 *
 * Resource route (no default export) so React Router returns the response
 * body directly without rendering a document. Shares its business logic
 * with the HTML route via the exported `createDocoAsAgentFromForm` helper.
 */
export async function loader() {
  return Response.json({
    error:
      "Use POST to create a Doco. See /onboarding/create/agent.txt for the field spec.",
  });
}

export async function action({ request }: { request: Request }) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      {
        error:
          "Content-Type must be application/x-www-form-urlencoded or multipart/form-data. See /onboarding/create/agent.txt for the field spec.",
      },
      { status: 400 },
    );
  }
  const baseUrl = getPublicBaseUrl(request);
  const result = await createDocoAsAgentFromForm({ form, baseUrl });
  return Response.json(result);
}
