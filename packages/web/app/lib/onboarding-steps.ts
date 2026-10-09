// The steps of getting a workspace going, shared by the page that walks them
// (components/onboarding-stepper.tsx), the reminder email
// (lib/onboarding-emails.ts) and what reads them as done
// (lib/onboarding.server.ts). Whoever creates a workspace walks all four;
// whoever joins it from an invite connects Doco to their agent, then asks it
// to start using Doco, which turns on their Doco hook.

export type OnboardingStep = "github" | "sources" | "mcp" | "agent";
export type JoinedAs = "creator" | "invitee";

/** The steps each kind of person walks, in order. */
export const ONBOARDING_STEPS: Record<JoinedAs, readonly OnboardingStep[]> = {
  creator: ["github", "sources", "mcp", "agent"],
  invitee: ["mcp", "agent"],
};

export const STEP_TITLES: Record<OnboardingStep, string> = {
  github: "Connect GitHub",
  sources: "Connect other sources of knowledge",
  mcp: "Connect Doco to your agent",
  agent: "Ask your agent to start using Doco",
};

export interface StepState {
  step: OnboardingStep;
  done: boolean;
}

/** The first step not done, or null once every one is. Pure. */
export function pendingStep(progress: { steps: readonly StepState[] }): OnboardingStep | null {
  return progress.steps.find((s) => !s.done)?.step ?? null;
}
