import { redirect } from "react-router";

// The feedback page moved from /mentor/feedback to /feedback (it's just
// "Feedback" now, not "mentor feedback"). Keep this path as a permanent
// redirect so older links and bookmarks still land on the page.
export function loader() {
  return redirect("/feedback", 301);
}

export function action() {
  return redirect("/feedback", 308);
}
