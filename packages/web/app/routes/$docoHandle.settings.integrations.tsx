// Integrations moved out from under /settings to its own top-level Doco
// section. Keep the legacy path working by redirecting.
import { redirect } from "react-router";

export function loader({ params }: { params: { docoHandle: string } }) {
  return redirect(`/${params.docoHandle}/integrations`);
}
