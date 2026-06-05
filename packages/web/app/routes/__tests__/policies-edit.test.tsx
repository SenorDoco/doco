import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The edit route is server-wired (loader/action pull in Postgres + access
// helpers) and uses react-router data APIs. Mock those boundaries so the
// component renders to static markup and the action runs against stubs. The
// policy-form modules are left REAL — the whole point of these tests is that
// the rendered form lists every check type and the action routes the new
// "activate" intent.
const mocks = vi.hoisted(() => ({
  loadPolicyForEdit: vi.fn(),
  transitionPolicyLifecycle: vi.fn(),
  capturePolicy: vi.fn(),
  loadDocoRouteForAdmin: vi.fn(),
  loadHostConfig: vi.fn(),
  authoringContextForRequest: vi.fn(),
  stampAuthenticatedCreator: vi.fn((d: unknown) => d),
  resolvePrincipalIdForUser: vi.fn(),
}));

vi.mock("~/lib/capture.server", () => ({
  loadPolicyForEdit: mocks.loadPolicyForEdit,
  transitionPolicyLifecycle: mocks.transitionPolicyLifecycle,
  capturePolicy: mocks.capturePolicy,
}));
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForAdmin: mocks.loadDocoRouteForAdmin,
}));
vi.mock("~/lib/host.server", () => ({ loadHostConfig: mocks.loadHostConfig }));
vi.mock("~/lib/authoring-source.server", () => ({
  authoringContextForRequest: mocks.authoringContextForRequest,
}));
vi.mock("~/lib/authenticated-creator.server", () => ({
  stampAuthenticatedCreator: mocks.stampAuthenticatedCreator,
}));
vi.mock("~/lib/principal-user.server", () => ({
  resolvePrincipalIdForUser: mocks.resolvePrincipalIdForUser,
}));
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

import EditPolicy, { action } from "../$docoHandle.policies.$policyId.edit";

type LoaderData = Parameters<typeof EditPolicy>[0]["loaderData"];

// A limits_edge predicate prefilled — the exact shape behind the reported bug
// (the retired single-intent ceiling the user was looking at).
const baseInitial = {
  kind: "deterministic" as const,
  agent_instruction: "",
  sub_kind: "limits_edge",
  edge_type: "supports",
  from_node_type: "",
  to_node_type: "",
  target_node_type: "intent",
  min_count: "",
  exempt_when_other_node_type: "",
  max_count: "1",
  direction: "outgoing",
  fields: "",
  field: "",
  pattern: "",
  flags: "",
  case_fold: false,
  node_types: "",
  edge_types: "",
  entity_types: "",
  list_field: "",
  incoming_node_type: "",
  incoming_field_must_match: "",
  initial_when_field: "",
  initial_when_equals: "",
  terminal_when_field: "",
  terminal_when_equals: "",
  when_node_type: "",
  on_violation: "block",
  fires_when_node_lifecycle: "",
};

function baseLoaderData(overrides: Partial<LoaderData> = {}): LoaderData {
  return {
    ownerSlug: "torre",
    docoSlug: "runbook",
    handle: "runbook",
    me: { id: "user_1", username: "alice", type: "person", isHuman: true },
    policyId: "policy_01HZEDIT",
    lifecycle: "active",
    initial: baseInitial,
    host: {},
    ...overrides,
  } as LoaderData;
}

function render(loaderData: LoaderData): string {
  return renderToStaticMarkup(<EditPolicy loaderData={loaderData} />);
}

describe("EditPolicy (render) — lifecycle-aware actions", () => {
  it("offers Retire (not Activate) for an active policy", () => {
    const html = render(baseLoaderData({ lifecycle: "active" }));
    expect(html).toContain('value="retire"');
    expect(html).not.toContain('value="activate"');
  });

  it("offers Activate (not Retire) for a retired policy and flags it as retired", () => {
    const html = render(baseLoaderData({ lifecycle: "retired" }));
    expect(html).toContain('value="activate"');
    expect(html).toContain("Activate policy");
    expect(html).not.toContain('value="retire"');
    expect(html).toContain("retired");
  });

  it("lists every newer check type in the menu (regression: they were missing)", () => {
    const html = render(baseLoaderData());
    for (const sk of [
      "limits_edge",
      "requires_edge_type",
      "forbids_field_pattern",
      "flow-wiring",
    ]) {
      expect(html).toContain(`value="${sk}"`);
    }
  });

  it("prefills the limits_edge fields it could not display before", () => {
    const html = render(baseLoaderData());
    // The ceiling's edge type + target + max_count are all selected/filled.
    expect(html).toContain('value="1"'); // max_count
    expect(html).toContain('name="max_count"');
    expect(html).toContain('name="direction"');
  });
});

describe("EditPolicy action — intent routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadDocoRouteForAdmin.mockResolvedValue({
      handle: "runbook",
      docoSlug: "runbook",
      ownerSlug: "torre",
      me: { id: "user_1", username: "alice" },
      meta: { docoId: "doco_1" },
      dir: "/tmp",
    });
  });

  function formRequest(fields: Record<string, string>): Request {
    return new Request("https://doco.test/runbook/policies/policy_x/edit", {
      method: "POST",
      body: new URLSearchParams(fields),
    });
  }

  it("activates a retired policy (intent=activate → newLifecycle active)", async () => {
    mocks.transitionPolicyLifecycle.mockResolvedValue({ ok: true });
    const result = await action({
      request: formRequest({ intent: "activate" }),
      params: { docoHandle: "runbook", policyId: "policy_x" },
    } as never);
    expect(mocks.transitionPolicyLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "doco",
        scopeId: "doco_1",
        policyId: "policy_x",
        newLifecycle: "active",
        actorId: "user_1",
      }),
    );
    expect(result).toEqual({ redirectTo: "/runbook/policies" });
  });

  it("retires on intent=retire", async () => {
    mocks.transitionPolicyLifecycle.mockResolvedValue({ ok: true });
    await action({
      request: formRequest({ intent: "retire" }),
      params: { docoHandle: "runbook", policyId: "policy_x" },
    } as never);
    expect(mocks.transitionPolicyLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ newLifecycle: "retired" }),
    );
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
