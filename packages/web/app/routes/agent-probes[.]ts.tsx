// Catch agent probing on common discovery paths and bounce them to the
// real recipe at /llms.txt. When a project owner says "let's start
// using Doco" or "visit doco.to and follow the wizard", agents
// typically probe /docs, /setup, /new, /agent, /agents, /api/docs,
// /api/setup before they think to try /llms.txt. Returning 404s makes
// them give up and ask the human; redirecting puts them on rails.
//
// Each probe path is registered in routes.ts pointing at this file.
import { redirect } from "react-router";

export async function loader() {
  return redirect("/llms.txt", 302);
}
