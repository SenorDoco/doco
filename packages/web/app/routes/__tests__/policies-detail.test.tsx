import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The policy detail route is server-wired (loader/action pull in Postgres +
// access helpers) and uses the react-router data APIs (Form / useActionData).
// Mock those boundaries so the component renders to static markup and the
// loader/action run against stubs.
const mocks = vi.hoisted(() => ({
  loadPolicyForEdit: vi.fn(),
  transitionPolicyLifecycle: vi.fn(),
  loadDocoRouteForRead: vi.fn(),
  loadDocoRouteForAdmin: vi.fn(),
  canEditPolicies: vi.fn(),
  loadHostConfig: vi.fn(),
}));

vi.mock("~/lib/capture.server", () => ({
  loadPolicyForEdit: mocks.loadPolicyForEdit,
  transitionPolicyLifecycle: mocks.transitionPolicyLifecycle,
}));
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: mocks.loadDocoRouteForRead,
  loadDocoRouteForAdmin: mocks.loadDocoRouteForAdmin,
  canEditPolicies: mocks.canEditPolicies,
}));
vi.mock("~/lib/host.server", () => ({ loadHostConfig: mocks.loadHostConfig }));
vi.mock("react-router", () => ({
  Form: ({ children }: { children?: ReactNode }) => <form>{children}</form>,
  Link: ({ children, to }: { children?: ReactNode; to: string }) => <a href={to}>{children}</a>,
  redirect: (url: string) => ({ redirectTo: url }),
  useActionData: () => undefined,
}));
vi.mock("~/components/site-header", () => ({ SiteHeader: () => null }));
vi.mock("~/components/breadcrumb", () => ({
  Breadcrumb: () => null,
  docoBreadcrumb: () => [],
}));

import PolicyDetail, { action, loader } from "../$docoHandle.policies.$policyId";

type LoaderData = Awaited<ReturnType<typeof loader>>;

function render(loaderData: LoaderData): string {
  return renderToStaticMarkup(<PolicyDetail loaderData={loaderData} />);
}

const baseItem = {
  id: "policy_01HZDETAIL",
  kind: "suggestion" as const,
  predicate: { agent_instruction: "Import nodes as active by default." },
  lifecycle: "active" as string | null,
  createdAt: "2026-06-01T00:00:00.000Z",
};

function baseLoaderData(overrides: Partial<LoaderData> = {}): LoaderData {
  return {
    ownerSlug: "torre",
    docoSlug: "runbook",
    handle: "runbook",
    me: { id: "user_1", username: "alice", type: "person", isHuman: true },
    host: {},
    canEdit: true,
    policyId: "policy_01HZDETAIL",
    item: baseItem,
    summary: "Import nodes as active by default.",
    ...overrides,
  } as LoaderData;
}

describe("PolicyDetail (render)", () => {
  it("shows Modify + Revoke for an owner on an active policy", () => {
    const html = render(baseLoaderData({ canEdit: true }));
    // Modify links to the edit form.
    expect(html).toContain('href="/runbook/policies/policy_01HZDETAIL/edit"');
    expect(html).toContain("Modify");
    // Revoke is a form submit carrying intent=revoke.
    expect(html).toContain('value="revoke"');
    expect(html).toContain("Revoke");
    // The stable id is surfaced so it can be cited/linked.
    expect(html).toContain("policy_01HZDETAIL");
    // The policy content renders.
    expect(html).toContain("Import nodes as active by default.");
  });

  it("hides Modify + Revoke for a non-owner viewer", () => {
    const html = render(baseLoaderData({ canEdit: false }));
    expect(html).not.toContain("/edit");
    expect(html).not.toContain('value="revoke"');
    expect(html).not.toContain("Revoke");
    // Read-only viewers still see the policy itself.
    expect(html).toContain("Import nodes as active by default.");
  });

  it("keeps Modify but drops Revoke once a policy is already retired", () => {
    const html = render(
      baseLoaderData({ canEdit: true, item: { ...baseItem, lifecycle: "retired" } }),
    );
    expect(html).toContain('href="/runbook/policies/policy_01HZDETAIL/edit"');
    expect(html).not.toContain('value="revoke"');
    expect(html).toContain("retired");
  });

  it("renders a retired policy's content struck through in red", () => {
    const retired = render(
      baseLoaderData({ canEdit: false, item: { ...baseItem, lifecycle: "retired" } }),
    );
    const active = render(baseLoaderData({ canEdit: false }));

    // On the policy's own page, a retired policy reads as crossed out in the
    // destructive (red) color — same treatment as in the list.
    expect(retired).toContain("line-through");
    expect(retired).toContain("text-destructive");
    expect(active).not.toContain("line-through");
  });
});

describe("policies/$policyId loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForRead.mockResolvedValue({
      ownerSlug: "torre",
      docoSlug: "runbook",
      handle: "runbook",
      me: { id: "user_1", username: "alice" },
      meta: { ownerId: "workspace_torre", docoId: "doco_1" },
    });
    mocks.loadHostConfig.mockResolvedValue({});
  });

  it("shapes the policy and resolves owner edit rights", async () => {
    mocks.loadPolicyForEdit.mockResolvedValue({
      ok: true,
      lifecycle: "active",
      data: {
        kind: "suggestion",
        predicate: { agent_instruction: "Cite the constitution." },
        created_at: "2026-06-01T00:00:00.000Z",
      },
    });
    mocks.canEditPolicies.mockResolvedValue(true);

    const data = await loader({
      request: new Request("https://doco.test/runbook/policies/policy_x"),
      params: { docoHandle: "runbook", policyId: "policy_x" },
    } as never);

    expect(data.canEdit).toBe(true);
    expect(data.policyId).toBe("policy_x");
    expect(data.item.kind).toBe("suggestion");
    expect(data.summary).toBe("Cite the constitution.");
  });

  it("404s when the policy is not in this Doco", async () => {
    mocks.loadPolicyForEdit.mockResolvedValue({ error: "Policy not found.", status: 404 });
    mocks.canEditPolicies.mockResolvedValue(false);

    await expect(
      loader({
        request: new Request("https://doco.test/runbook/policies/policy_missing"),
        params: { docoHandle: "runbook", policyId: "policy_missing" },
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("policies/$policyId action (revoke)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForAdmin.mockResolvedValue({
      handle: "runbook",
      me: { id: "user_1", username: "alice" },
      meta: { ownerId: "workspace_torre", docoId: "doco_1" },
    });
  });

  function formRequest(fields: Record<string, string>): Request {
    return new Request("https://doco.test/runbook/policies/policy_x", {
      method: "POST",
      body: new URLSearchParams(fields),
    });
  }

  it("retires the policy and redirects back to the policies list", async () => {
    mocks.transitionPolicyLifecycle.mockResolvedValue({ ok: true });

    const result = await action({
      request: formRequest({ intent: "revoke" }),
      params: { docoHandle: "runbook", policyId: "policy_x" },
    } as never);

    expect(mocks.transitionPolicyLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "doco",
        scopeId: "doco_1",
        policyId: "policy_x",
        newLifecycle: "retired",
        actorId: "user_1",
      }),
    );
    expect(result).toEqual({ redirectTo: "/runbook/policies" });
  });

  it("rejects an unknown intent", async () => {
    const result = (await action({
      request: formRequest({ intent: "explode" }),
      params: { docoHandle: "runbook", policyId: "policy_x" },
    } as never)) as Response;

    expect(result.status).toBe(400);
    expect(mocks.transitionPolicyLifecycle).not.toHaveBeenCalled();
  });
});
