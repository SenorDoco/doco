import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EntityId } from "@doco/shared";

/**
 * Token store. Holds both invitation tokens (5-min single-use, ADR-037) and
 * session tokens (no default expiry, revocable, ADR-038). One file per Host;
 * not committed to git per ADR-039. Phase 6 swaps the file backend for a
 * managed encrypted DB; interface stays the same.
 */

export type StoredToken = SessionToken | InvitationToken | ClaimToken;

export interface SessionToken {
  kind: "session";
  token: string; // opaque, 256 bits hex
  principal_id: EntityId<"principal">;
  issued_at: string;
  expires_at: string | null; // null = never (sessions; ADR-037)
  invited_by: EntityId<"principal"> | null; // chain root reached at a person (ADR-035 invariant)
  revoked: boolean;
}

export interface InvitationToken {
  kind: "invitation";
  token: string;
  inviter_id: EntityId<"principal">; // person or agent that issued the invite
  issued_at: string;
  expires_at: string; // ALWAYS set; +5 min from issued_at (ADR-037)
  used: boolean; // single-use; flips to true on redemption
  revoked: boolean;
}

/**
 * Claim token (ADR-073). Issued when an agent creates an unclaimed Doco via
 * the onboarding wizard. The owner visits `/claim/<token>`, signs in, and
 * takes ownership of the Doco + the bootstrap-owned agent Principal.
 *
 * Long expiry (~30 days) so the owner has time to act; single-use.
 */
export interface ClaimToken {
  kind: "claim";
  token: string;
  doco_id: string; // the Doco to be claimed
  bootstrap_agent_id: EntityId<"principal">; // the agent created at the same time, owner=host-bootstrap
  issued_at: string;
  expires_at: string;
  used: boolean;
}

interface TokenStoreFile {
  schema_version: 2;
  tokens: StoredToken[];
}

const TOKEN_LEN_BYTES = 32; // 256 bits → 64 hex chars
const INVITATION_TTL_MS = 5 * 60 * 1000; // 5 minutes per ADR-037
const CLAIM_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days per ADR-073

export class TokenStore {
  constructor(private readonly path: string) {}

  static forDoco(docoRoot: string): TokenStore {
    return new TokenStore(join(docoRoot, ".doco", "tokens.json"));
  }

  async load(): Promise<TokenStoreFile> {
    if (!existsSync(this.path)) {
      return { schema_version: 2, tokens: [] };
    }
    const text = await readFile(this.path, "utf8");
    const parsed = JSON.parse(text) as { schema_version: number; tokens: unknown[] };
    // Migrate v1 (session-only, no `kind` field) → v2 transparently in memory.
    const tokens: StoredToken[] = parsed.tokens.map((t) => {
      const tok = t as Record<string, unknown>;
      if (!tok.kind) return { ...tok, kind: "session" } as unknown as SessionToken;
      return tok as unknown as StoredToken;
    });
    return { schema_version: 2, tokens };
  }

  async save(file: TokenStoreFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(file, null, 2), "utf8");
  }

  // ───────────────────────────────────────────── invitation tokens

  /** Issue a 5-minute single-use invitation token (ADR-037). */
  async issueInvitationToken(inviterId: EntityId<"principal">): Promise<InvitationToken> {
    const file = await this.load();
    const now = new Date();
    const tok: InvitationToken = {
      kind: "invitation",
      token: randomBytes(TOKEN_LEN_BYTES).toString("hex"),
      inviter_id: inviterId,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + INVITATION_TTL_MS).toISOString(),
      used: false,
      revoked: false,
    };
    file.tokens.push(tok);
    await this.save(file);
    return tok;
  }

  /** Look up an invitation; returns null if missing, expired, used, or revoked. */
  async resolveInvitation(token: string): Promise<InvitationToken | null> {
    const file = await this.load();
    const t = file.tokens.find((x) => x.token === token && x.kind === "invitation") as
      | InvitationToken
      | undefined;
    if (!t) return null;
    if (t.used || t.revoked) return null;
    if (Date.parse(t.expires_at) < Date.now()) return null;
    return t;
  }

  /** Mark an invitation token as used (one-shot). */
  async markInvitationUsed(token: string): Promise<void> {
    const file = await this.load();
    const t = file.tokens.find((x) => x.token === token && x.kind === "invitation") as
      | InvitationToken
      | undefined;
    if (!t) throw new Error("invitation token not found");
    t.used = true;
    await this.save(file);
  }

  // ───────────────────────────────────────────── session tokens

  async issueSessionToken(
    principalId: EntityId<"principal">,
    invitedBy?: EntityId<"principal">,
  ): Promise<SessionToken> {
    const file = await this.load();
    const token: SessionToken = {
      kind: "session",
      token: randomBytes(TOKEN_LEN_BYTES).toString("hex"),
      principal_id: principalId,
      issued_at: new Date().toISOString(),
      expires_at: null,
      invited_by: invitedBy ?? null,
      revoked: false,
    };
    file.tokens.push(token);
    await this.save(file);
    return token;
  }

  /** Resolve a session token; returns null if missing or revoked. */
  async resolve(token: string): Promise<SessionToken | null> {
    const file = await this.load();
    const t = file.tokens.find((t) => t.token === token && t.kind === "session") as
      | SessionToken
      | undefined;
    if (!t || t.revoked) return null;
    return t;
  }

  /**
   * Revoke a session token with strict cascade per ADR-038: every session
   * token whose `invited_by` ancestry passes through this token's principal
   * is also revoked.
   */
  async revoke(token: string, cascade: boolean = true): Promise<number> {
    const file = await this.load();
    let count = 0;
    const target = file.tokens.find((t) => t.token === token && t.kind === "session") as
      | SessionToken
      | undefined;
    if (!target) return 0;
    if (!target.revoked) {
      target.revoked = true;
      count = 1;
    }
    if (cascade) {
      const chain = new Set<EntityId<"principal">>([target.principal_id]);
      let added = true;
      while (added) {
        added = false;
        for (const t of file.tokens) {
          if (t.kind !== "session") continue;
          if (t.revoked) continue;
          if (t.invited_by && chain.has(t.invited_by) && !chain.has(t.principal_id)) {
            chain.add(t.principal_id);
            t.revoked = true;
            count++;
            added = true;
          }
        }
      }
    }
    await this.save(file);
    return count;
  }

  // ───────────────────────────────────────────── claim tokens (ADR-073)

  async issueClaimToken(
    docoId: string,
    bootstrapAgentId: EntityId<"principal">,
  ): Promise<ClaimToken> {
    const file = await this.load();
    const now = new Date();
    const tok: ClaimToken = {
      kind: "claim",
      token: randomBytes(TOKEN_LEN_BYTES).toString("hex"),
      doco_id: docoId,
      bootstrap_agent_id: bootstrapAgentId,
      issued_at: now.toISOString(),
      expires_at: new Date(now.getTime() + CLAIM_TTL_MS).toISOString(),
      used: false,
    };
    file.tokens.push(tok);
    await this.save(file);
    return tok;
  }

  async resolveClaim(token: string): Promise<ClaimToken | null> {
    const file = await this.load();
    const t = file.tokens.find((x) => x.token === token && x.kind === "claim") as
      | ClaimToken
      | undefined;
    if (!t) return null;
    if (t.used) return null;
    if (Date.parse(t.expires_at) < Date.now()) return null;
    return t;
  }

  /**
   * Status of a claim token (for the agent to poll while reminding the
   * owner). Distinguishes pending / claimed / expired / unknown so the
   * agent can decide whether to keep reminding, congratulate, or escalate.
   */
  async getClaimStatus(token: string): Promise<{
    status: "pending" | "claimed" | "expired" | "unknown";
    doco_id?: string;
    expires_at?: string;
  }> {
    const file = await this.load();
    const t = file.tokens.find((x) => x.token === token && x.kind === "claim") as
      | ClaimToken
      | undefined;
    if (!t) return { status: "unknown" };
    if (t.used) return { status: "claimed", doco_id: t.doco_id };
    if (Date.parse(t.expires_at) < Date.now())
      return { status: "expired", doco_id: t.doco_id, expires_at: t.expires_at };
    return { status: "pending", doco_id: t.doco_id, expires_at: t.expires_at };
  }

  async markClaimUsed(token: string): Promise<void> {
    const file = await this.load();
    const t = file.tokens.find((x) => x.token === token && x.kind === "claim") as
      | ClaimToken
      | undefined;
    if (!t) throw new Error("claim token not found");
    t.used = true;
    await this.save(file);
  }

  /** Lightweight summary for the browser-facing /invite page. */
  async listOpenInvitations(): Promise<InvitationToken[]> {
    const file = await this.load();
    const now = Date.now();
    return file.tokens.filter(
      (t): t is InvitationToken =>
        t.kind === "invitation" && !t.used && !t.revoked && Date.parse(t.expires_at) >= now,
    );
  }
}

/** Resolve a Bearer token from an Authorization header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? (m[1] ?? "").trim() : null;
}
