import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { EntityId } from "@doco/shared";

/**
 * Invite store. Persisted in Postgres as a host-scoped JSON blob.
 * Retired session-token and CLI-authorization rows are ignored on read;
 * OAuth is the bearer credential path.
 */

/**
 * Single-use invite to join a Doco. Any user with access on the target
 * can mint an Invite at or below their own role; redemption writes a
 * membership row for the signed-in human. Agents use OAuth instead of
 * redeeming invite URLs. The invite-code path component is itself the
 * secret.
 *
 * The first Invite a Doco ever has is the one returned by anonymous
 * `POST /api/v1/docos` — it gives the creator their first sharable
 * link without a separate mint step.
 */
export interface Invite {
  kind: "invite";
  /** Opaque hex token. Path component of the invite URL. */
  code: string;
  /**
   * Level the grant lands at on redemption (decision_01KS0JBJ5X0AZ4XJJFKEWE1R62).
   * - "doco" (default for back-compat): inserts into doco_users.
   * - "org": inserts into org_users for `org_id`.
   *
   * Pre-existing invites without this field are treated as "doco".
   */
  level?: "org" | "doco";
  /** Doco this invite is anchored to. Org-only invites can omit it. */
  doco_id?: EntityId<"doco">;
  /** Org targeted by org-level invites. Required when level === "org". */
  org_id?: EntityId<"organization">;
  /** Principal that minted this invite (null for anonymous-creation seed). */
  minted_by_user_id: EntityId<"principal"> | null;
  /**
   * Role the redeemer receives on the targeted level. Written into the
   * level-appropriate users table on consume. Optional in storage for
   * back-compat: pre-cutover Invites lack the field; their redeemer
   * falls back to `owner` (matching the v8 backfill posture). Mint
   * paths after the cutover always set it explicitly.
   */
  role?: "owner" | "approver" | "author" | "reader";
  /** ISO timestamp this invite expires (default 7 days from issue). */
  expires_at: string;
  /** ISO timestamp this invite was issued. */
  issued_at: string;
  /** Lifecycle status of the invite. */
  status: "pending" | "consumed" | "expired" | "revoked";
  /**
   * The Principal that redeemed this invite. Set when status flips to
   * "consumed". For multi-use invites (future), this would be the
   * most-recent redeemer.
   */
  redeemed_by_user_id: EntityId<"principal"> | null;
  /** ISO timestamp of redemption. Null until consumed. */
  redeemed_at: string | null;
}

interface InviteStoreFile {
  schema_version: 2;
  tokens: Invite[];
}

const INVITE_CODE_BYTES = 32; // 256 bits -> 64 hex chars

export class InviteStore {
  constructor(private readonly path: string) {}

  static forDoco(docoRoot: string): InviteStore {
    return new InviteStore(join(docoRoot, ".doco", "tokens.json"));
  }

  async load(): Promise<InviteStoreFile> {
    const { withClient } = await import("@doco/db");
    const r = await withClient((c) =>
      c.query<{ blob: InviteStoreFile }>("SELECT blob FROM tokens_blob WHERE key = $1 LIMIT 1", [
        this.path,
      ]),
    );
    if (!r.rows[0]) return { schema_version: 2, tokens: [] };
    // pg returns jsonb as an already-parsed object. Older blobs may still
    // contain retired session/CLI rows; invite flows should simply ignore
    // them and rewrite the blob without them on the next mutation.
    const parsed = r.rows[0].blob as unknown as { schema_version: number; tokens?: unknown[] };
    const rawTokens = Array.isArray(parsed.tokens) ? parsed.tokens : [];
    const tokens = rawTokens.filter((t): t is Invite => {
      const tok = t as Record<string, unknown>;
      return tok.kind === "invite" && typeof tok.code === "string";
    });
    return { schema_version: 2, tokens };
  }

  async save(file: InviteStoreFile): Promise<void> {
    const { withClient } = await import("@doco/db");
    await withClient((c) =>
      c.query(
        `INSERT INTO tokens_blob (key, blob, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (key) DO UPDATE
           SET blob = EXCLUDED.blob,
               updated_at = now()`,
        [this.path, JSON.stringify(file)],
      ),
    );
  }

  // ───────────────────────────────────────────── invites

  /**
   * Mint a new Invite for a Doco. Returns the freshly-issued Invite row;
   * the caller renders `invite_url = https://<host>/invite/<code>`.
   *
   * @param docoId             Doco the invite grants access to.
   * @param mintedByUserId Principal that issued the invite (null for the
   *                            anonymous-create seed invite).
   * @param ttlDays             Days until the invite expires (default 7).
   */
  async issueInvite(
    docoId: EntityId<"doco"> | null,
    mintedByUserId: EntityId<"principal"> | null,
    ttlDays = 7,
    role: "owner" | "approver" | "author" | "reader" = "author",
    opts: {
      level?: "org" | "doco";
      org_id?: EntityId<"organization">;
    } = {},
  ): Promise<Invite> {
    const file = await this.load();
    const now = new Date();
    const expires = new Date(now.getTime() + Math.max(1, Math.min(365, ttlDays)) * 86400 * 1000);
    const level = opts.level ?? "doco";
    if (!docoId && level !== "org") {
      throw new Error("docoId is required for doco-level invites.");
    }
    const invite: Invite = {
      kind: "invite",
      code: randomBytes(INVITE_CODE_BYTES).toString("hex"),
      level,
      ...(docoId ? { doco_id: docoId } : {}),
      ...(opts.org_id ? { org_id: opts.org_id } : {}),
      minted_by_user_id: mintedByUserId,
      role,
      expires_at: expires.toISOString(),
      issued_at: now.toISOString(),
      status: "pending",
      redeemed_by_user_id: null,
      redeemed_at: null,
    };
    file.tokens.push(invite);
    await this.save(file);
    return invite;
  }

  /**
   * Find an Invite by its code. Auto-expires past-TTL invites on read so
   * callers don't redeem stale ones. Returns null if missing.
   */
  async findInvite(code: string): Promise<Invite | null> {
    const file = await this.load();
    const row = file.tokens.find((t) => t.kind === "invite" && t.code === code) as
      | Invite
      | undefined;
    if (!row) return null;
    if (row.status === "pending" && Date.parse(row.expires_at) < Date.now()) {
      row.status = "expired";
      await this.save(file);
    }
    return row;
  }

  /**
   * Single-use redemption: mark the Invite as consumed and stamp it with
   * the redeemer. Returns the prior row (for the caller to read doco_id,
   * etc.). Returns null if the invite is missing, expired, or already
   * consumed.
   */
  async consumeInvite(
    code: string,
    redeemedByUserId: EntityId<"principal">,
  ): Promise<Invite | null> {
    const file = await this.load();
    const row = file.tokens.find((t) => t.kind === "invite" && t.code === code) as
      | Invite
      | undefined;
    if (!row) return null;
    if (row.status === "pending" && Date.parse(row.expires_at) < Date.now()) {
      row.status = "expired";
      await this.save(file);
      return null;
    }
    if (row.status !== "pending") return null;
    row.status = "consumed";
    row.redeemed_by_user_id = redeemedByUserId;
    row.redeemed_at = new Date().toISOString();
    await this.save(file);
    return row;
  }

  async revokeInvite(code: string): Promise<boolean> {
    const file = await this.load();
    const row = file.tokens.find((t) => t.kind === "invite" && t.code === code) as
      | Invite
      | undefined;
    if (!row) return false;
    if (row.status !== "pending") return false;
    row.status = "revoked";
    await this.save(file);
    return true;
  }

  /**
   * List every Invite ever issued for a Doco, freshest first. Used by
   * the per-Doco /invites page (web management UI). Auto-expires past-TTL
   * pending rows on read so the UI reflects the same status the redeem
   * path would see.
   */
  async listInvitesForDoco(docoId: EntityId<"doco">): Promise<Invite[]> {
    const file = await this.load();
    let mutated = false;
    const now = Date.now();
    const matches: Invite[] = [];
    for (const t of file.tokens) {
      if (t.kind !== "invite") continue;
      if (t.doco_id !== docoId) continue;
      if (t.status === "pending" && Date.parse(t.expires_at) < now) {
        t.status = "expired";
        mutated = true;
      }
      matches.push(t);
    }
    if (mutated) await this.save(file);
    return matches.sort((a, b) => Date.parse(b.issued_at) - Date.parse(a.issued_at));
  }
}
