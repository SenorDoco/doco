import { redirect } from "react-router";
import { SiteHeader } from "~/components/site-header";
import { getCurrentPrincipal } from "~/lib/session.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { username?: string };
}) {
  const me = await getCurrentPrincipal(request);
  const pathname = new URL(request.url).pathname;
  if (!me) throw redirect(`/sign-in?next=${encodeURIComponent(pathname)}`);
  if (params.username !== me.username) {
    throw redirect(`/users/${encodeURIComponent(me.username)}`);
  }
  return { me };
}

export function meta({ params }: { params: { username?: string } }) {
  return [{ title: `${params.username ?? "User"} · Doco` }];
}

export default function UserProfile({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { me } = loaderData;
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-6xl px-6 py-10">
        <p className="text-sm text-muted-foreground">Not much to do here, Señor(a) {me.username}</p>
      </main>
    </div>
  );
}
