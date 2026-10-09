// GET /agents/doco-hook.mjs: the Doco hook script (app/hook/doco-hook.mjs),
// served whole so a project saves it with one curl, its length named so an
// agent can size it up before it downloads. Public, like /agents.
import source from "~/hook/doco-hook.mjs?raw";

export function loader() {
  return new Response(source, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Content-Length": String(new TextEncoder().encode(source).length),
      "Cache-Control": "public, max-age=600",
    },
  });
}
