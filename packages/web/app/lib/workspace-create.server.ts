// Creating a workspace: the workspace and its default Docos
// (addWorkspaceByHandle), its creator's onboarding steps, and the welcome
// email that links to it. /new-workspace and New Doco's "new workspace" both
// create through here.
import { withClient } from "@doco/db";
import { waitUntil } from "@vercel/functions";
import { emailBaseUrl, sendEmail } from "./email.server";
import { welcomeEmail } from "./onboarding-emails";
import { startOnboarding } from "./onboarding.server";
import { addWorkspaceByHandle } from "./redeem.server";

export async function createWorkspace(opts: {
  handle: string;
  ownerUserId: string;
  autoSuffix?: boolean;
}): Promise<{ id: string; handle: string }> {
  const workspace = await addWorkspaceByHandle({
    handle: opts.handle,
    ownerUserId: opts.ownerUserId,
    autoSuffix: opts.autoSuffix,
  });
  const email = await withClient(async (c) => {
    await startOnboarding(c, {
      workspaceId: workspace.id,
      userId: opts.ownerUserId,
      joinedAs: "creator",
    });
    const user = await c.query<{ email: string | null }>("SELECT email FROM users WHERE id = $1", [
      opts.ownerUserId,
    ]);
    return user.rows[0]?.email || null;
  });
  if (email) {
    waitUntil(
      sendEmail({
        to: email,
        ...welcomeEmail({ baseUrl: emailBaseUrl(), workspaceHandle: workspace.handle }),
      }),
    );
  }
  return workspace;
}
