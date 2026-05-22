// /<doco-handle>/perspectives — the picker page reached from the "+"
// tab. Lists every available perspective (builtin + user-created) and
// lets owners/approvers attach the ones that aren't already attached.
//
// Loader is read-gated, action is approver-gated. Form posts route to
// the /api/perspectives.json action which already enforces the gate
// and returns JSON.

import { Form, Link, redirect, useNavigation } from "react-router";
import { Breadcrumb, docoBreadcrumb } from "~/components/breadcrumb";
import { SiteHeader } from "~/components/site-header";
import { canApproveDoco, loadDocoRouteForRead } from "~/lib/doco-access.server";
import { loadHostConfig } from "~/lib/host.server";
import {
  attachPerspectiveToDoco,
  listAvailablePerspectives,
  listPerspectivesForDoco,
} from "~/lib/perspectives.server";

export async function loader({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  const [available, attached, canAdmin, host] = await Promise.all([
    listAvailablePerspectives(),
    listPerspectivesForDoco(ctx.meta.docoId),
    canApproveDoco(ctx.meta, ctx.me?.id ?? null),
    loadHostConfig(),
  ]);
  const attachedIds = new Set(attached.map((p) => p.id));
  return {
    handle: ctx.handle,
    ownerSlug: ctx.ownerSlug,
    available,
    attachedIds: Array.from(attachedIds),
    canAdmin,
    me: ctx.me,
    host,
  };
}

export async function action({
  request,
  params,
}: {
  request: Request;
  params: { docoId: string };
}) {
  const ctx = await loadDocoRouteForRead(request, params);
  if (!ctx.me) {
    return Response.json({ ok: false, error: "anonymous_forbidden" }, { status: 403 });
  }
  if (!(await canApproveDoco(ctx.meta, ctx.me.id))) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const form = await request.formData();
  const perspectiveId = form.get("perspective_id");
  if (typeof perspectiveId !== "string" || perspectiveId.length === 0) {
    return Response.json({ ok: false, error: "missing_perspective_id" }, { status: 400 });
  }
  await attachPerspectiveToDoco({
    docoId: ctx.meta.docoId,
    perspectiveId,
    attachedByCollaboratorId: ctx.me.id,
  });
  // Bounce the user back to the Doco home with the newly-attached
  // perspective active, so they can see it immediately.
  const slug = form.get("perspective_slug");
  const url = `/${ctx.handle}${typeof slug === "string" && slug ? `?perspective=${encodeURIComponent(slug)}` : ""}`;
  return redirect(url);
}

export function meta({ params }: { params: { docoHandle?: string } }) {
  return [{ title: `Perspectives · ${params.docoHandle ?? ""} · Doco` }];
}

export default function PerspectivesPicker({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { handle, ownerSlug, available, attachedIds, canAdmin, me } = loaderData;
  const attachedSet = new Set(attachedIds);
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  return (
    <div>
      <SiteHeader mode="host" me={me} />
      <main className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-4 space-y-1">
          <Breadcrumb
            items={[
              ...docoBreadcrumb({ ownerSlug, handle }),
              { label: "Perspectives", to: `/${handle}/perspectives` },
            ]}
          />
          <div className="flex items-center justify-between gap-2">
            <h1 className="text-lg font-semibold tracking-tight">Perspectives</h1>
            <Link
              to={`/${handle}`}
              className="neo-raised-sm rounded-md px-3 py-1.5 text-xs font-semibold"
            >
              ← Back to {handle}
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">
            Visualization perspectives switch how the Doco's neurons and synapses render. Attach
            any of the perspectives below to add a tab to this Doco's overview page.
            {!canAdmin ? (
              <span className="ml-1 italic">
                Attaching requires owner or approver access.
              </span>
            ) : null}
          </p>
        </div>
        <ul className="neo-raised divide-y divide-border rounded-md bg-card">
          {available.map((p) => {
            const isAttached = attachedSet.has(p.id);
            return (
              <li key={p.id} className="flex items-start gap-4 px-4 py-3">
                <span aria-hidden className="mt-0.5 text-xl leading-none">
                  {p.icon ?? "•"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <h2 className="text-sm font-semibold">{p.name}</h2>
                    {p.ownerHandle ? (
                      <span className="text-xs text-muted-foreground">by {p.ownerHandle}</span>
                    ) : null}
                    {p.isBuiltin ? (
                      <span className="neo-raised-sm rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        builtin
                      </span>
                    ) : null}
                  </div>
                  {p.description ? (
                    <p className="mt-1 text-xs text-muted-foreground">{p.description}</p>
                  ) : null}
                </div>
                <div className="shrink-0">
                  {isAttached ? (
                    <span className="inline-block rounded-md bg-input px-2 py-1 text-xs text-muted-foreground">
                      Attached
                    </span>
                  ) : canAdmin ? (
                    <Form method="post">
                      <input type="hidden" name="perspective_id" value={p.id} />
                      <input type="hidden" name="perspective_slug" value={p.slug} />
                      <button
                        type="submit"
                        disabled={submitting}
                        className="neo-raised-sm inline-block rounded-md px-3 py-1 text-xs font-semibold disabled:opacity-50"
                      >
                        Attach
                      </button>
                    </Form>
                  ) : (
                    <span className="inline-block text-xs text-muted-foreground">—</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </main>
    </div>
  );
}
