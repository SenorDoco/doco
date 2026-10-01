// Catch agent probing on common discovery paths and bounce them to /agents,
// which holds the agent instructions. When a project owner says "let's start
// using Doco", agents typically probe /docs, /setup, /agent, /api/docs before
// finding the instructions. Returning 404s makes them give up and ask the
// human; redirecting puts them on rails.
//
// Each probe path is registered in routes.ts pointing at this file.
import { redirect } from "react-router";
import { AGENT_INSTRUCTIONS_PATH } from "~/lib/agent-instructions";

export async function loader() {
  return redirect(AGENT_INSTRUCTIONS_PATH, 302);
}
