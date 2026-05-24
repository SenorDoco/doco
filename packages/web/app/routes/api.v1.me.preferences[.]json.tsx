// Per-user UI preferences. Stored on `collaborators.data.preferences` —
// a small JSONB sidecar for browser-only state (graph auto-reorder,
// etc.) that should survive across devices the same human signs in
// from. No Doco scope: preferences are about the viewer, not the
// content.
//
// Auth: cookie-session signed-in user only. There is no anonymous
// preferences row to read or write — every method requires a current
// principal.
import { getCollaboratorById, patchCollaboratorData } from "@doco/db";
import { getCurrentPrincipal } from "~/lib/session.server";

export type PreferencesRecord = Record<string, unknown>;

function preferencesFromRow(data: Record<string, unknown> | undefined): PreferencesRecord {
  const raw = data?.preferences;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as PreferencesRecord;
  }
  return {};
}

async function loadCurrentPreferences(meId: string): Promise<PreferencesRecord> {
  const row = await getCollaboratorById(meId);
  if (!row) return {};
  return preferencesFromRow(row.data);
}

export async function loader({ request }: { request: Request }) {
  const me = await getCurrentPrincipal(request);
  if (!me) return Response.json({ error: "Sign in required." }, { status: 401 });
  return Response.json({ preferences: await loadCurrentPreferences(me.id) });
}

export async function action({ request }: { request: Request }) {
  if (request.method !== "PATCH" && request.method !== "POST") {
    return Response.json({ error: "Use POST or PATCH." }, { status: 405 });
  }
  const me = await getCurrentPrincipal(request);
  if (!me) return Response.json({ error: "Sign in required." }, { status: 401 });

  const ct = (request.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("application/json")) {
    return Response.json({ error: "Content-Type must be application/json." }, { status: 400 });
  }
  let patch: PreferencesRecord;
  try {
    const body = (await request.json()) as { preferences?: PreferencesRecord };
    patch = body?.preferences ?? {};
  } catch (e) {
    return Response.json({ error: `Invalid JSON body: ${(e as Error).message}` }, { status: 400 });
  }
  if (typeof patch !== "object" || Array.isArray(patch)) {
    return Response.json({ error: "`preferences` must be an object." }, { status: 400 });
  }

  // Read-merge-write so partial updates from the client don't clobber
  // sibling preference keys set by other UI surfaces.
  const existing = await loadCurrentPreferences(me.id);
  const merged = { ...existing, ...patch };
  const row = await patchCollaboratorData(me.id, { preferences: merged });
  if (!row) return Response.json({ error: "Could not update preferences." }, { status: 500 });
  return Response.json({ preferences: preferencesFromRow(row.data) });
}
