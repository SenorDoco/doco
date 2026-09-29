// Catch agent probing on common discovery paths and bounce them to the
// home page, which holds the agent instructions. When a project owner says
// "let's start using Doco", agents typically probe /docs, /setup, /agent,
// /api/docs before reading the home page. Returning 404s makes them give up
// and ask the human; redirecting puts them on rails.
//
// Each probe path is registered in routes.ts pointing at this file.
import { redirect } from "react-router";

export async function loader() {
  return redirect("/", 302);
}
