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
    process.env.DOCO_SLACK_INSTALL_URL = undefined;
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
    process.env.DOCO_SLACK_INSTALL_URL = "https://slack.example/install";
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
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: "slack",
          installHref: "https://slack.example/install",
        }),
        expect.objectContaining({
          id: "google-chat",
          installHref: null,
        }),
      ]),
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

  it("does not expose deployment environment variable names to the browser", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({
      id: "collaborator_alice",
      username: "alice",
    });
    mocks.loadScopeOptions.mockResolvedValue([]);

    const data = await loader({ request: new Request("https://doco.test/integrations") });

    expect(data.providers[0]).toMatchObject({
      id: "slack",
      installHref: null,
      setupSummary: "Create and approve a Slack app for this Doco deployment.",
    });
    expect(data.providers[0]).not.toHaveProperty("installEnv");
  });
});
