import { redirect } from "react-router";

export async function loader({ request }: { request: Request }) {
  const url = new URL(request.url);
  const qs = url.searchParams.toString();
  throw redirect(qs ? `/new-doco?${qs}` : "/new-doco");
}

export async function action() {
  throw redirect("/new-doco");
}

export function meta() {
  return [{ title: "New doco · Doco" }];
}

export default function LegacyNewDocoTemplateRedirect() {
  return null;
}
