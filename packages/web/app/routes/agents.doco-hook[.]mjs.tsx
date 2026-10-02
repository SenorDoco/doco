// GET /agents/doco-hook.mjs: the Doco hook script (app/hook/doco-hook.mjs),
// served whole so a project saves it with one curl. Public, like /agents.
import source from "~/hook/doco-hook.mjs?raw";

export function loader() {
  return new Response(source, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=600",
    },
  });
}
