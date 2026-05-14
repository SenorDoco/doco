// /onboarding/create — the role-question page is gone with
// decision_01KRKZM14WNA1685GN0F12WCKM (agent-initiated Doco creation now
// goes through `doco login --create <slug>`). Anyone landing here is a
// human creating their first Doco — send them straight to the human
// form.
import { redirect } from "react-router";

export function loader() {
  return redirect("/onboarding/create/human");
}

export default function CreateRedirect() {
  return null;
}
