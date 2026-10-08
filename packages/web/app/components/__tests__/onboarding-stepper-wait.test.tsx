// @vitest-environment happy-dom
//
// Alexander, 2026-10-08: doco_brief returned 504 and the Doco hook timed out
// while an agent set up torre. When the agent's hook first ran, the agent step
// reloaded the page on every render, about 70 requests a second for five
// minutes, which starved the database the brief runs on
// (decision_01M4ESD5BZKX3JYKYK84VKK8RR). The step now shows what its poll says
// in place and reloads nothing while it waits.
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { RouterProvider, createMemoryRouter, useLoaderData } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentInstructionsForWorkspace } from "~/lib/agent-instructions";
import type { OnboardingView } from "~/lib/onboarding-view.server";
import { OnboardingStepper } from "../onboarding-stepper";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ON_AGENT: OnboardingView = {
  workspaceHandle: "acme",
  joinedAs: "invitee",
  steps: [{ step: "agent", done: false }],
  pending: "agent",
  github: { available: true, docos: [] },
  sources: [],
  agent: {
    instructions: agentInstructionsForWorkspace("https://doco.to", "acme"),
    agentsChatsHandle: "acme-agents-chats",
    wrote: false,
    hook: false,
  },
};

/** What the server knows of the person's setup, which the agent moves on. */
let server: { wrote: boolean; hook: boolean; done: boolean };
let pageLoads: number;
let renders: number;
let container: HTMLDivElement;
let root: Root;

/** A round trip, so a request can be overtaken by the next one. */
const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 200));

function Page() {
  const { view } = useLoaderData() as { view: OnboardingView };
  // A step that reloads on every render never settles; stop it here so the
  // test fails instead of hanging.
  if (++renders > 100) throw new Error("The page re-rendered in a loop.");
  return <OnboardingStepper view={view} />;
}

beforeEach(async () => {
  vi.useFakeTimers();
  server = { wrote: false, hook: false, done: false };
  pageLoads = 0;
  renders = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const router = createMemoryRouter(
    [
      {
        id: "workspace",
        path: "/workspaces/acme",
        loader: async () => {
          pageLoads++;
          await roundTrip();
          return { view: { ...ON_AGENT, agent: { ...ON_AGENT.agent, ...server } } };
        },
        element: <Page />,
      },
      {
        path: "/workspaces/acme/onboarding",
        loader: async () => {
          await roundTrip();
          return {
            steps: [{ step: "agent", done: server.done }],
            pending: server.done ? null : "agent",
            agent: { wrote: server.wrote, hook: server.hook },
          };
        },
      },
    ],
    {
      initialEntries: ["/workspaces/acme"],
      hydrationData: { loaderData: { workspace: { view: ON_AGENT } } },
    },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe("OnboardingStepper's agent step", () => {
  it("says the hook is on once the poll does, without reloading the page", async () => {
    server.hook = true;
    await wait(20_000);

    expect(container.textContent).toContain("The hook is on.");
    expect(pageLoads).toBe(0);
  });

  it("says the agent wrote its note once the poll does, without reloading the page", async () => {
    server.wrote = true;
    await wait(20_000);

    expect(container.textContent).toContain("Your agent wrote in acme-agents-chats.");
    expect(pageLoads).toBe(0);
  });

  it("says the workspace is set up once the poll says every step is done", async () => {
    server = { wrote: true, hook: true, done: true };
    await wait(5_000);

    expect(document.body.textContent).toContain("acme is set up");
    expect(pageLoads).toBe(0);
  });
});
