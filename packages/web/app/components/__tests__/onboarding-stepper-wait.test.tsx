// @vitest-environment happy-dom
//
// Alexander, 2026-10-08: doco_brief returned 504 and the Doco hook timed out
// while an agent set up torre. When the agent's hook first ran, the agent step
// reloaded the page on every render, about 70 requests a second for five
// minutes, which starved the database the brief runs on
// (decision_01M4ESD5BZKX3JYKYK84VKK8RR). The steps that wait on the agent now
// show what their poll says in place, and reload the page once, when the
// person moves on to the next step.
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { RouterProvider, createMemoryRouter, useLoaderData } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentInstructionsForWorkspace } from "~/lib/agent-instructions";
import type { OnboardingView } from "~/lib/onboarding-view.server";
import { OnboardingStepper } from "../onboarding-stepper";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** What the server knows of the person's setup, which the agent moves on. */
let server: { connected: boolean; wrote: boolean; hook: boolean };
let pageLoads: number;
let renders: number;
let container: HTMLDivElement;
let root: Root;

function viewNow(): OnboardingView {
  const done = server.connected && server.wrote && server.hook;
  return {
    workspaceHandle: "acme",
    joinedAs: "invitee",
    steps: [
      { step: "mcp", done: server.connected },
      { step: "agent", done },
    ],
    pending: !server.connected ? "mcp" : done ? null : "agent",
    github: { available: true, docos: [] },
    sources: [],
    mcp: { guides: [] },
    agent: {
      instructions: agentInstructionsForWorkspace("https://doco.to", "acme"),
      agentsChatsHandle: "acme-agents-chats",
      wrote: server.wrote,
      hook: server.hook,
    },
  } as OnboardingView;
}

/** A round trip, so a request can be overtaken by the next one. */
const roundTrip = () => new Promise((resolve) => setTimeout(resolve, 200));

function Page() {
  const { view } = useLoaderData() as { view: OnboardingView };
  // A step that reloads on every render never settles; stop it here so the
  // test fails instead of hanging.
  if (++renders > 100) throw new Error("The page re-rendered in a loop.");
  return <OnboardingStepper view={view} />;
}

async function mount(initial: Partial<typeof server>) {
  server = { connected: false, wrote: false, hook: false, ...initial };
  pageLoads = 0;
  renders = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const first = viewNow();
  const router = createMemoryRouter(
    [
      {
        id: "workspace",
        path: "/workspaces/acme",
        loader: async () => {
          pageLoads++;
          await roundTrip();
          return { view: viewNow() };
        },
        element: <Page />,
      },
      {
        path: "/workspaces/acme/onboarding",
        loader: async () => {
          await roundTrip();
          const view = viewNow();
          return {
            steps: view.steps,
            pending: view.pending,
            agent: { wrote: server.wrote, hook: server.hook },
          };
        },
      },
    ],
    {
      initialEntries: ["/workspaces/acme"],
      hydrationData: { loaderData: { workspace: { view: first } } },
    },
  );
  await act(async () => root.render(<RouterProvider router={router} />));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

/** Let time pass a second at a time: React flushes effects when each act
 *  ends, so a reload an effect starts gets its round trip in the next one. */
async function wait(ms: number) {
  for (let left = ms; left > 0; left -= 1_000) {
    await act(() => vi.advanceTimersByTimeAsync(Math.min(1_000, left)));
  }
}

describe("OnboardingStepper's agent step", () => {
  it("says the hook is on once the poll does, without reloading the page", async () => {
    await mount({ connected: true });
    server.hook = true;
    await wait(20_000);

    expect(container.textContent).toContain("The hook is on.");
    expect(pageLoads).toBe(0);
  });

  it("says the agent wrote its note once the poll does, without reloading the page", async () => {
    await mount({ connected: true });
    server.wrote = true;
    await wait(20_000);

    expect(container.textContent).toContain("Your agent wrote in acme-agents-chats.");
    expect(pageLoads).toBe(0);
  });

  it("says the workspace is set up once the poll says every step is done", async () => {
    await mount({ connected: true });
    server = { connected: true, wrote: true, hook: true };
    await wait(5_000);

    expect(document.body.textContent).toContain("acme is set up");
    expect(pageLoads).toBe(0);
  });
});

// Alexander, 2026-10-09: the person connects Doco to their agent first, and
// the page waits for the sign-in, then moves on to the message for the agent.
describe("OnboardingStepper's connect step", () => {
  it("moves on to the message for the agent once the poll says Doco is connected, reloading the page once", async () => {
    await mount({});
    expect(container.textContent).toContain("Waiting for you to sign in to Doco from your agent");
    expect(container.textContent).not.toContain("Message for your agent");
    server.connected = true;
    await wait(8_000);

    expect(container.textContent).toContain("Message for your agent");
    expect(pageLoads).toBe(1);
    await wait(20_000);
    expect(pageLoads).toBe(1);
  });
});
