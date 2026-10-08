// What a workspace page needs to walk a person through its steps
// (components/onboarding-stepper.tsx): where they stand, and for each step
// what it connects. Null once every step is done, or for someone with no steps
// there. Reaching the agent step gives a workspace made before every new one
// came with an Agents chats Doco its own, so the agent has somewhere to write.
import { withClient } from "@doco/db";
import { getPublicBaseUrl } from "@doco/shared";
import { agentInstructionsForWorkspace } from "./agent-instructions";
import { findDocoTemplateMeta } from "./doco-templates-meta";
import { githubAppConfigured } from "./github-app.server";
import { GITHUB_IMPORTS } from "./github-imports";
import { listImportDocos } from "./github-setup.server";
import { KNOWLEDGE_SOURCE_INTEGRATIONS } from "./integrations-catalog";
import { KNOWLEDGE_SOURCE_CONNECTORS, sourceConnected } from "./knowledge-sources.server";
import {
  type JoinedAs,
  type OnboardingStep,
  type StepState,
  pendingStep,
} from "./onboarding-steps";
import { loadOnboardingProgress } from "./onboarding.server";
import { ensureWorkspaceDoco } from "./workspace-helpers.server";

export interface OnboardingView {
  workspaceHandle: string;
  joinedAs: JoinedAs;
  steps: StepState[];
  /** The step the person is on: the first one not done. */
  pending: OnboardingStep;
  github: {
    /** Whether this host can connect GitHub at all. */
    available: boolean;
    /** The workspace's Docos GitHub fills, once they exist. */
    docos: Array<{ handle: string; template: string; label: string }>;
  };
  sources: Array<{
    id: string;
    name: string;
    description: string;
    available: boolean;
    /** The workspace's Doco for the source, once it exists. */
    docoHandle: string | null;
    connected: boolean;
  }>;
  agent: {
    /** The message to send the agent (agentInstructionsForWorkspace). */
    instructions: string;
    /** The workspace's Agents chats Doco, where the agent notes it got them. */
    agentsChatsHandle: string | null;
    /** Whether the agent wrote that note. */
    wrote: boolean;
    /** Whether the person's Doco hook is on. */
    hook: boolean;
  };
}

export async function loadOnboardingView(opts: {
  request: Request;
  workspace: { id: string; handle: string };
  userId: string;
}): Promise<OnboardingView | null> {
  const { request, workspace, userId } = opts;
  const progress = await withClient((c) =>
    loadOnboardingProgress(c, { workspaceId: workspace.id, userId }),
  );
  const pending = progress ? pendingStep(progress) : null;
  if (!progress || !pending) return null;

  const baseUrl = getPublicBaseUrl(request);
  const creator = progress.joinedAs === "creator";
  const importDocos = creator ? ((await listImportDocos([workspace.id]))[workspace.id] ?? {}) : {};
  const agentsChats =
    pending === "agent"
      ? await ensureWorkspaceDoco({
          workspace,
          template: "agents-chats",
          handleSuffix: "agents-chats",
          userId,
        })
      : null;

  return withClient(async (c) => {
    const docoFor = async (template: string) =>
      (
        await c.query<{ id: string; handle: string }>(
          `SELECT id, handle FROM docos
            WHERE workspace_id = $1 AND deleted_at IS NULL AND data->>'template_handle' = $2
            ORDER BY created_at, id
            LIMIT 1`,
          [workspace.id, template],
        )
      ).rows[0] ?? null;

    const sources: OnboardingView["sources"] = [];
    if (creator) {
      for (const integration of KNOWLEDGE_SOURCE_INTEGRATIONS) {
        const doco = await docoFor(integration.template);
        sources.push({
          id: integration.id,
          name: integration.name,
          description:
            findDocoTemplateMeta(integration.template)?.description ?? integration.description,
          available: KNOWLEDGE_SOURCE_CONNECTORS[integration.id]?.configured() ?? false,
          docoHandle: doco?.handle ?? null,
          connected: doco ? await sourceConnected(c, integration.id, doco.id) : false,
        });
      }
    }

    return {
      workspaceHandle: workspace.handle,
      joinedAs: progress.joinedAs,
      steps: progress.steps,
      pending,
      github: {
        available: githubAppConfigured(),
        docos: GITHUB_IMPORTS.flatMap((i) =>
          importDocos[i.id]
            ? [{ handle: importDocos[i.id].handle, template: i.template, label: i.label }]
            : [],
        ),
      },
      sources,
      agent: {
        instructions: agentInstructionsForWorkspace(baseUrl, workspace.handle),
        agentsChatsHandle: (agentsChats ?? (await docoFor("agents-chats")))?.handle ?? null,
        ...progress.agent,
      },
    };
  });
}
