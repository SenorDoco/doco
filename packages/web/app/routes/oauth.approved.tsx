// GET /oauth/approved — Doco-branded interstitial that paints between
// the user clicking Approve at /oauth/authorize and the browser landing
// on the runtime's localhost callback. Without it, users went straight
// from the Doco approve form to an unstyled `localhost:53682/callback`
// page — no confirmation that what they approved actually took effect.
//
// Lives as a real React Router route (not a 200 Response from the
// authorize action) because RR v7 framework mode serializes non-3xx
// action Responses into the page data stream — they never paint. See
// commit 9fbbf72 for the failure mode that rationale ruled out.
//
// Security: `?to=` is a user-supplied URL. The loader extracts the
// `code` query param from it, peeks the auth code row, and confirms
// the redirect target matches the redirect_uri bound to that code.
// Without that check this route would be an open redirect.

import { useLoaderData } from "react-router";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/card";
import { SingleColumnPageMain } from "~/components/page-main";
import { SiteHeader } from "~/components/site-header";
import { getClient, peekAuthorizationCode } from "~/lib/oauth-server.server";
import { type CurrentPrincipal, getCurrentPrincipalAsync } from "~/lib/session.server";

interface LoaderData {
  to: string;
  client_name: string;
  me: CurrentPrincipal | null;
}

// The browser fires meta-refresh after this many seconds. Long enough
// for the user to register Doco branding ("yes, my approval took
// effect"), short enough not to feel stuck.
const REDIRECT_DELAY_SECONDS = 1.5;

function failureResponse(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}

export async function loader({ request }: { request: Request }): Promise<LoaderData> {
  const url = new URL(request.url);
  const rawTo = url.searchParams.get("to");
  if (!rawTo) throw failureResponse("missing ?to= parameter", 400);

  let target: URL;
  try {
    target = new URL(rawTo);
  } catch {
    throw failureResponse("invalid ?to= URL", 400);
  }

  const code = target.searchParams.get("code");
  if (!code) {
    throw failureResponse("?to= must include a ?code= query parameter", 400);
  }

  const peeked = await peekAuthorizationCode(code);
  if (!peeked) {
    throw failureResponse("authorization code is unknown, expired, or already consumed", 400);
  }

  // Confirm `to` (origin + path, with code/state stripped) matches the
  // redirect_uri the auth code was issued for. Anyone could craft a
  // /oauth/approved?to=https://evil.example/?code=<real-code> URL
  // otherwise.
  const targetWithoutAuthParams = new URL(target.toString());
  targetWithoutAuthParams.searchParams.delete("code");
  targetWithoutAuthParams.searchParams.delete("state");
  const expected = new URL(peeked.redirect_uri);
  if (
    targetWithoutAuthParams.origin !== expected.origin ||
    targetWithoutAuthParams.pathname !== expected.pathname
  ) {
    throw failureResponse("?to= does not match the redirect_uri bound to this code", 400);
  }

  const client = await getClient(peeked.client_id);
  if (!client) {
    throw failureResponse("oauth client no longer exists", 400);
  }

  const me = await getCurrentPrincipalAsync(request);

  return {
    to: target.toString(),
    client_name: client.client_name ?? peeked.client_id.slice(0, 20),
    me,
  };
}

// Don't leak the auth code through Referer to the runtime's localhost
// listener (it gets the code in its URL already, no reason to also
// hand it our full URL). The auth code is single-use; never cache.
export function headers() {
  return {
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
  };
}

export function meta({ data }: { data: LoaderData | undefined }) {
  return [
    { title: "Access approved · Doco" },
    ...(data
      ? [{ httpEquiv: "refresh", content: `${REDIRECT_DELAY_SECONDS}; url=${data.to}` }]
      : []),
  ];
}

export default function ApprovedPage() {
  const data = useLoaderData() as LoaderData;
  const redirectScript = `setTimeout(function () { location.replace(${JSON.stringify(
    data.to,
  )}); }, ${Math.round(REDIRECT_DELAY_SECONDS * 1000)});`;
  return (
    <div>
      <SiteHeader mode="host" me={data.me} />
      <SingleColumnPageMain className="py-8 space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Access approved</CardTitle>
            <CardDescription>
              Returning you to <strong>{data.client_name}</strong>…
            </CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              <a className="underline" href={data.to} rel="noreferrer">
                Click here if you aren't redirected automatically.
              </a>
            </p>
          </CardContent>
        </Card>
      </SingleColumnPageMain>
      <script
        // biome-ignore lint/security/noDangerouslySetInnerHtml: trusted server-side string, JSON-stringified
        dangerouslySetInnerHTML={{ __html: redirectScript }}
      />
    </div>
  );
}
