// Someone who isn't an owner of a GitHub organization can only ask its owners
// to install Doco's GitHub App. Doco remembers who asked, for which Docos, and
// when GitHub reports the installation made on that request, it lands on those
// Docos: their repositories become selectable, nothing is connected yet.
// PGlite runs the real schema and the real request + installation SQL.
import type { PGlite } from "@electric-sql/pglite";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ db: null as unknown as PGlite }));
vi.mock("@doco/db", () => ({
  withClient: (fn: (c: unknown) => unknown) => fn(state.db),
}));
const getInstallationAccount = vi.hoisted(() => vi.fn());
vi.mock("../github-app.server", () => ({ getInstallationAccount }));

import { freshDb } from "../../../../db/src/__tests__/fresh-db";
import {
  fulfillInstallationRequests,
  listConnections,
  listInstallationAuthorizations,
  recordInstallationRequest,
} from "../github-connection.server";

beforeEach(async () => {
  vi.clearAllMocks();
  getInstallationAccount.mockResolvedValue({ account: "torreco", repository_selection: "all" });
  const db = await freshDb();
  state.db = db;
  await db.exec(`
    INSERT INTO workspaces (id, handle, name) VALUES ('workspace_acme', 'acme', 'Acme');
    INSERT INTO docos (id, handle, owner_id, workspace_id, data) VALUES
      ('doco_prs', 'acme-pull-requests', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "github-pull-requests"}'),
      ('doco_code', 'acme-codebase', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "codebase"}'),
      ('doco_other', 'acme-other', 'workspace_acme', 'workspace_acme',
        '{"template_handle": "github-pull-requests"}');
  `);
});

async function requestsOn(docoId: string) {
  const r = await state.db.query<{ requests: unknown }>(
    `SELECT data->'github_integration'->'installation_requests' AS requests
       FROM docos WHERE id = $1`,
    [docoId],
  );
  return r.rows[0]?.requests ?? null;
}

describe("an installation an owner approves on someone's request", () => {
  it("lands on every Doco that person asked for it from, and only there", async () => {
    await recordInstallationRequest("doco_prs", "JoseManuelPR");
    await recordInstallationRequest("doco_code", "JoseManuelPR");
    await recordInstallationRequest("doco_other", "someone-else");

    // GitHub names the requester with its own casing.
    const fulfilled = await fulfillInstallationRequests("josemanuelpr", 169619515);

    expect(fulfilled.sort()).toEqual(["doco_code", "doco_prs"]);
    expect(getInstallationAccount).toHaveBeenCalledWith(169619515);
    for (const docoId of ["doco_prs", "doco_code"]) {
      expect(await listInstallationAuthorizations(docoId)).toEqual([
        expect.objectContaining({
          installation_id: 169619515,
          account: "torreco",
          repository_selection: "all",
        }),
      ]);
      // Selectable, not connected: the person still picks the repositories.
      expect(await listConnections(docoId)).toEqual([]);
      expect(await requestsOn(docoId)).toEqual([]);
    }
    expect(await listInstallationAuthorizations("doco_other")).toEqual([]);
    expect(await requestsOn("doco_other")).toEqual([
      { github_login: "someone-else", requested_at: expect.any(String) },
    ]);
  });

  it("is answered once: a later installation on the same person's request finds nothing", async () => {
    await recordInstallationRequest("doco_prs", "ana");

    expect(await fulfillInstallationRequests("ana", 1)).toEqual(["doco_prs"]);
    expect(await fulfillInstallationRequests("ana", 2)).toEqual([]);
    expect(
      (await listInstallationAuthorizations("doco_prs")).map((a) => a.installation_id),
    ).toEqual([1]);
  });

  it("asks GitHub nothing when nobody asked for it", async () => {
    expect(await fulfillInstallationRequests("ana", 1)).toEqual([]);
    expect(getInstallationAccount).not.toHaveBeenCalled();
  });

  it("keeps one request per person per Doco when they ask again", async () => {
    await recordInstallationRequest("doco_prs", "Ana");
    await recordInstallationRequest("doco_prs", "ana");
    await recordInstallationRequest("doco_prs", "bob");

    expect(await requestsOn("doco_prs")).toEqual([
      { github_login: "ana", requested_at: expect.any(String) },
      { github_login: "bob", requested_at: expect.any(String) },
    ]);
  });
});
