import { computeCoverage } from "@doco/lints";
import { docoPath, readDocoFullSlug } from "~/lib/db";
import { type CurrentPrincipal, getCurrentPrincipal } from "~/lib/session";
import { CoverageView } from "~/components/coverage-view";

/**
 * /<owner>/<doco>/coverage — per-Doco drift detection (ADR-090) in host mode.
 */
export function loader({
  params,
  request,
}: {
  params: { ownerSlug: string; docoSlug: string };
  request: Request;
}) {
  const { ownerSlug, docoSlug } = params;
  const me = getCurrentPrincipal(request);
  const report = computeCoverage(docoPath(ownerSlug, docoSlug));
  return { report, ownerSlug, docoSlug, fullSlug: readDocoFullSlug(ownerSlug, docoSlug), me };
}

export function meta({ data }: { data: Awaited<ReturnType<typeof loader>> | undefined }) {
  if (!data) return [{ title: "Coverage · Doco" }];
  return [{ title: `Coverage · ${data.fullSlug}` }];
}

export default function DocoCoverage({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { report, ownerSlug, docoSlug, fullSlug, me } = loaderData;
  return (
    <CoverageView
      report={report}
      context={fullSlug}
      docoScope={{ ownerSlug, docoSlug }}
      me={me}
    />
  );
}
