import { redirect } from "react-router";
import { clearSessionCookie } from "~/lib/session.server";

export function action() {
  return redirect("/", { headers: { "Set-Cookie": clearSessionCookie() } });
}

// Visiting /sign-out via GET also signs you out — convenience.
export function loader() {
  return redirect("/", { headers: { "Set-Cookie": clearSessionCookie() } });
}
