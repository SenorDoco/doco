// The GitHub settings panel moved into the Integrations section. Keep this path
// working by redirecting; the connection model is now a managed list there.
import { redirect } from "react-router";

export function loader({ params }: { params: { docoHandle: string } }) {
  return redirect(`/${params.docoHandle}/settings/integrations`);
}
