// /dashboard — the old signed-in home, kept as a redirect so bookmarks and
// old links land on the Workspaces page, which replaced it.
import { redirect } from "react-router";

export function loader() {
  return redirect("/workspaces", 301);
}
