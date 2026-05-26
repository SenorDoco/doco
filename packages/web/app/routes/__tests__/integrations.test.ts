import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  loadScopeOptions: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({
  getCurrentPrincipal: mocks.getCurrentPrincipal,
}));

vi.mock("~/lib/api-keys.server", () => ({
  loadScopeOptions: mocks.loadScopeOptions,
}));

import { loader } from "../integrations";

describe("/integrations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects anonymous users to sign in", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);

    const response = (await loader({
      request: new Request("https://doco.test/integrations"),
    }).catch((error: Response) => error)) as Response;

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/sign-in?next=%2Fintegrations");
  });

  it("loads the signed-in user's accessible integration targets", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.loadScopeOptions.mockResolvedValue([
      {
        level: "doco",
        id: "doco_bpms",
        label: "torre/bpms",
        myRole: "author",
      },
    ]);

    await expect(
      loader({ request: new Request("https://doco.test/integrations") }),
    ).resolves.toEqual({
      me: {
        id: "collaborator_alice",
        username: "alice",
      },
      scopeOptions: [
        {
          level: "doco",
          id: "doco_bpms",
          label: "torre/bpms",
          myRole: "author",
        },
      ],
    });
    expect(mocks.loadScopeOptions).toHaveBeenCalledWith("collaborator_alice");
  });
});
