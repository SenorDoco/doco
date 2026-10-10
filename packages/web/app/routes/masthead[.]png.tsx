// GET /masthead.png?t=<token> — the masthead at the top of the activity digest
// email: a workspace's newspaper title, The <Workspace> Times, set in Chomsky
// (lib/masthead.server.ts). The token is the title sealed by the server, so
// only Doco chooses what is drawn, and since a token always draws the same
// image, browsers and the CDN keep it for a year.
import { mastheadPng, readMastheadToken } from "~/lib/masthead.server";

export async function loader({ request }: { request: Request }) {
  const title = readMastheadToken(new URL(request.url).searchParams.get("t") ?? "");
  if (title === null) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(mastheadPng(title)), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=31536000, s-maxage=31536000, immutable",
    },
  });
}
