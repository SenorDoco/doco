import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHost, addPrincipal, listPrincipals } from "@doco/host";
import { makeApp } from "../server.js";

let tmp: string;
let root: string;
let aliceId: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "doco-invite-"));
  root = join(tmp, "host");
  await createHost(root, { name: "Test Host" });
  aliceId = await addPrincipal(root, { username: "alice", email: "alice@example.com" });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("ADR-068 invitation flow", () => {
  it("issue → redeem → spawn — full agent-creation cycle", async () => {
    const app = makeApp({ docoRoot: root, defaultPrincipalId: aliceId });

    // 1. Alice (human) issues an invitation.
    const inviteRes = await app.request("/api/v1/invitations", { method: "POST" });
    expect(inviteRes.status).toBe(200);
    const invite = (await inviteRes.json()) as {
      token: string;
      url: string;
      expires_at: string;
      inviter: { id: string; username: string };
    };
    expect(invite.token).toMatch(/^[0-9a-f]{64}$/);
    expect(invite.inviter.username).toBe("alice");
    // 5-min expiry
    expect(Date.parse(invite.expires_at) - Date.now()).toBeGreaterThan(4 * 60 * 1000);
    expect(Date.parse(invite.expires_at) - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);

    // 2. Agent redeems the invitation.
    const redeemRes = await app.request("/api/v1/invitations/redeem", {
      method: "POST",
      headers: {
        authorization: `Bearer ${invite.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        display_name: "Claude Sonnet 5",
        model: "claude-sonnet-5",
        provider: "anthropic",
        capabilities: ["read", "write"],
      }),
    });
    expect(redeemRes.status).toBe(200);
    const redeemed = (await redeemRes.json()) as {
      session_token: string;
      principal: { id: string; username: string; type: string; owner_id: string };
    };
    expect(redeemed.principal.type).toBe("agent");
    expect(redeemed.principal.owner_id).toBe(aliceId);
    expect(redeemed.principal.username.startsWith("alice/")).toBe(true);
    expect(redeemed.session_token).toMatch(/^[0-9a-f]{64}$/);

    // 3. Same invitation token cannot be used a second time (single-use).
    const replayRes = await app.request("/api/v1/invitations/redeem", {
      method: "POST",
      headers: { authorization: `Bearer ${invite.token}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "another agent" }),
    });
    expect(replayRes.status).toBe(401);

    // 4. Agent uses the session token to spawn a child agent.
    const spawnRes = await app.request("/api/v1/agents/spawn", {
      method: "POST",
      headers: {
        authorization: `Bearer ${redeemed.session_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ display_name: "Claude Sonnet 5 child", model: "claude-sonnet-5" }),
    });
    expect(spawnRes.status).toBe(200);
    const child = (await spawnRes.json()) as {
      session_token: string;
      principal: { id: string; username: string; owner_id: string };
    };
    expect(child.principal.owner_id).toBe(redeemed.principal.id);
    expect(child.principal.username.startsWith(`${redeemed.principal.username}/`)).toBe(true);

    // 5. Trust invariant (rule_agent_ancestry_terminates_at_human): the
    //    child's owner is the parent agent; the parent's owner is alice (human).
    //    Walking owner_id back lands at type=human in two hops.
    const principals = await listPrincipals(root);
    expect(principals.find((p) => p.id === aliceId)).toBeTruthy();
    expect(principals.find((p) => p.id === redeemed.principal.id)).toBeTruthy();
    expect(principals.find((p) => p.id === child.principal.id)).toBeTruthy();
  });

  it("expired invitation is rejected", async () => {
    const app = makeApp({ docoRoot: root, defaultPrincipalId: aliceId });
    const inviteRes = await app.request("/api/v1/invitations", { method: "POST" });
    const { token } = (await inviteRes.json()) as { token: string };

    // Manually expire the invitation in the store file.
    const fs = await import("node:fs/promises");
    const path = join(root, ".doco", "tokens.json");
    const file = JSON.parse(await fs.readFile(path, "utf8")) as {
      tokens: { token: string; expires_at: string }[];
    };
    const t = file.tokens.find((x) => x.token === token);
    if (t) t.expires_at = new Date(Date.now() - 60_000).toISOString();
    await fs.writeFile(path, JSON.stringify(file, null, 2), "utf8");

    const redeemRes = await app.request("/api/v1/invitations/redeem", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ display_name: "late agent" }),
    });
    expect(redeemRes.status).toBe(401);
  });

  it("revocation cascades through the agent ancestry chain (ADR-038)", async () => {
    const app = makeApp({ docoRoot: root, defaultPrincipalId: aliceId });

    // Create invitation → redeem → spawn child
    const invite = (await (await app.request("/api/v1/invitations", { method: "POST" })).json()) as {
      token: string;
    };
    const parent = (await (
      await app.request("/api/v1/invitations/redeem", {
        method: "POST",
        headers: { authorization: `Bearer ${invite.token}`, "content-type": "application/json" },
        body: JSON.stringify({ display_name: "parent agent" }),
      })
    ).json()) as { session_token: string; principal: { id: string } };
    const child = (await (
      await app.request("/api/v1/agents/spawn", {
        method: "POST",
        headers: {
          authorization: `Bearer ${parent.session_token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ display_name: "child agent" }),
      })
    ).json()) as { session_token: string };

    // Sanity: child token works pre-revocation.
    const before = await app.request("/api/v1/invitations", {
      method: "POST",
      headers: { authorization: `Bearer ${child.session_token}` },
    });
    expect(before.status).toBe(200);

    // Revoke the parent's session — strict cascade should also kill the child's.
    const revokeRes = await app.request(`/api/v1/sessions/${parent.session_token}/revoke`, {
      method: "POST",
    });
    expect(revokeRes.status).toBe(200);
    const { revoked } = (await revokeRes.json()) as { revoked: number };
    expect(revoked).toBe(2);

    // Child token now rejects.
    const afterParent = await app.request("/api/v1/invitations", {
      method: "POST",
      headers: { authorization: `Bearer ${parent.session_token}` },
    });
    const afterChild = await app.request("/api/v1/invitations", {
      method: "POST",
      headers: { authorization: `Bearer ${child.session_token}` },
    });
    // No `defaultPrincipalId` for these — without a valid token, principal_id isn't set.
    // But our app accepts unauthenticated when defaultPrincipalId is set; in the test
    // we set it to aliceId, so even a revoked-token request still gets aliceId.
    // Re-test with a fresh app instance that has no default principal:
    const strictApp = makeApp({ docoRoot: root });
    const strictParent = await strictApp.request("/api/v1/invitations", {
      method: "POST",
      headers: { authorization: `Bearer ${parent.session_token}` },
    });
    const strictChild = await strictApp.request("/api/v1/invitations", {
      method: "POST",
      headers: { authorization: `Bearer ${child.session_token}` },
    });
    expect(strictParent.status).toBe(401);
    expect(strictChild.status).toBe(401);
    void afterParent;
    void afterChild;
  });

  it("only humans can revoke (other operations work for agents per ADR-040 — only delete_doco is human-only)", async () => {
    const app = makeApp({ docoRoot: root, defaultPrincipalId: aliceId });
    const invite = (await (await app.request("/api/v1/invitations", { method: "POST" })).json()) as {
      token: string;
    };
    const agent = (await (
      await app.request("/api/v1/invitations/redeem", {
        method: "POST",
        headers: { authorization: `Bearer ${invite.token}`, "content-type": "application/json" },
        body: JSON.stringify({ display_name: "agent" }),
      })
    ).json()) as { session_token: string; principal: { id: string } };

    // Agent tries to revoke a session — forbidden.
    const strictApp = makeApp({ docoRoot: root });
    const revokeAsAgent = await strictApp.request(
      `/api/v1/sessions/${agent.session_token}/revoke`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${agent.session_token}` },
      },
    );
    expect(revokeAsAgent.status).toBe(403);
  });
});
