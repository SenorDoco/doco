import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EntityId } from "@doco/shared";

/**
 * Token store. Holds session tokens (no default expiry, revocable, ADR-038)
 * and CLI authorization rows (decision_01KRKZM14WNA1685GN0F12WCKM).
 * Persisted in Postgres as a host-scoped JSON blob.
 */

export type StoredToken = SessionToken | CliAuthorization | Invite;

/**
 * Single-use invite to join a Doco. Per the invite-flow redesign — any
 * user (agent or human) holding a valid access credential on a Doco can mint
 * an Invite; redemption mints a fresh per-user access credential bound to the
 * same Doco. The invite-code path component is itself the secret;
 * there is no separate "Authorize" step.
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
   * - "scope": inserts into scope_users for `scope_id`; the redeemer
   *   gets implicit doco-reader visibility for the containing `doco_id`.
   *
   * Pre-existing invites without this field are treated as "doco".
   */
  level?: "org" | "doco" | "scope";
  /** Doco this invite is anchored to. Always set — scope invites carry
   * the parent doco; org invites still carry the doco the inviter was
   * looking at when they minted (used for back-links and audit). */
  doco_id: EntityId<"doco">;
  /** Org targeted by org-level invites. Required when level === "org". */
  org_id?: EntityId<"organization">;
  /** Scope targeted by scope-level invites. Required when level === "scope". */
  scope_id?: EntityId<"scope">;
  /** Principal that minted this invite (null for anonymous-creation seed). */
  minted_by_principal_id: EntityId<"principal"> | null;
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
  redeemed_by_principal_id: EntityId<"principal"> | null;
  /** ISO timestamp of redemption. Null until consumed. */
  redeemed_at: string | null;
}

export interface SessionToken {
  kind: "session";
  token: string; // opaque, 256 bits hex — exposed as DOCO_ACCESS
  principal_id: EntityId<"principal">;
  issued_at: string;
  expires_at: string | null; // null = never (sessions; ADR-037)
  invited_by: EntityId<"principal"> | null; // chain root reached at a person (ADR-035 invariant)
  revoked: boolean;
  /**
   * The Doco this credential is scoped to. When set, bootstrap can infer
   * the Doco from DOCO_ACCESS without a separate doco-id query parameter.
   *
   * Nullable for back-compat with credentials minted before the
   * per-Doco access-credential model. Those callers used a separate DOCO_ID +
   * Authorization Bearer header.
   */
  bound_doco_id: EntityId<"doco"> | null;
}

/**
 * CLI authorization (decision_01KRKZM14WNA1685GN0F12WCKM). Vercel-style
 * browser-authorize handoff: a CLI process running on behalf of a project
 * owner POSTs /api/v1/cli/device-init, gets back a state nonce + short
 * code, opens the project owner's browser at /cli/authorize?state=<nonce>.
 * The project owner signs in (if not already), reviews the CLI identity
 * card, and clicks Authorize. The server mints an agent Principal owned
 * by the project owner + a session token, and stashes them on this row.
 * The CLI polls /api/v1/cli/device-exchange with the state nonce and
 * consumes the row exactly once.
 *
 * Replaces the host-bootstrap detour + /claim/<token> handoff.
 */
export interface CliAuthorization {
  kind: "cli_authorization";
  /** ULID-style id for log lookups. */
  id: string;
  /** Hex-random nonce in the authorize URL; used by the CLI to poll. */
  state_nonce: string;
  /** Short alphanumeric code (8 chars), shown if the CLI's loopback bind failed and the project owner has to paste it. */
  short_code: string;
  /** CLI metadata for the authorize screen — modeled on Vercel's card. */
  cli_version: string;
  cli_hostname: string;
  cli_user_agent: string;
  status: "pending" | "approved" | "denied" | "exchanged" | "expired";
  /** Set when status flips to "approved" or beyond. */
  approved_by_principal_id: EntityId<"principal"> | null;
  /** The agent Principal minted on approval (owner_id = approved_by_principal_id). */
  issued_principal_id: EntityId<"principal"> | null;
  /** The session token minted on approval. Cleared on "exchanged". */
  issued_token: string | null;
  /** The Doco slug the agent created during approval (if the form requested it). */
  created_doco_handle: string | null;
  /** The immutable Doco id created during approval (if the form requested it). */
  created_doco_id: string | null;
  /** The owner_slug under which docos created in this session live. */
  approved_owner_username: string | null;
  created_at: string;
  approved_at: string | null;
  expires_at: string;
}

interface TokenStoreFile {
  schema_version: 2;
  tokens: StoredToken[];
}

const TOKEN_LEN_BYTES = 32; // 256 bits → 64 hex chars
const CLI_AUTH_TTL_MS = 10 * 60 * 1000; // 10 minutes for the project owner to click Approve

const SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/I/1 — easier to read aloud
const SHORT_CODE_LEN = 8;
function generateShortCode(): string {
  const bytes = randomBytes(SHORT_CODE_LEN);
  let out = "";
  for (let i = 0; i < SHORT_CODE_LEN; i++) {
    out += SHORT_CODE_ALPHABET[bytes[i]! % SHORT_CODE_ALPHABET.length];
  }
  return out;
}

export class TokenStore {
  constructor(private readonly path: string) {}

  static forDoco(docoRoot: string): TokenStore {
    return new TokenStore(join(docoRoot, ".doco", "tokens.json"));
  }

  async load(): Promise<TokenStoreFile> {
    const { withClient } = await import("@doco/db");
    const r = await withClient((c) =>
      c.query<{ blob: TokenStoreFile }>(
        "SELECT blob FROM tokens_blob WHERE key = $1 LIMIT 1",
        [this.path],
      ),
    );
    if (!r.rows[0]) return { schema_version: 2, tokens: [] };
    // pg returns jsonb as an already-parsed object. Normalize older rows that
    // predate the `kind` field while keeping storage Postgres-only.
    const parsed = r.rows[0].blob as unknown as { schema_version: number; tokens: unknown[] };
    const tokens: StoredToken[] = parsed.tokens.map((t) => {
      const tok = t as Record<string, unknown>;
      if (!tok.kind) return { ...tok, kind: "session" } as unknown as SessionToken;
      return tok as unknown as StoredToken;
    });
    return { schema_version: 2, tokens };
  }

  async save(file: TokenStoreFile): Promise<void> {
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

  // ───────────────────────────────────────────── session tokens

  async issueSessionToken(
    principalId: EntityId<"principal">,
    invitedBy?: EntityId<"principal">,
    boundDocoId?: EntityId<"doco"> | null,
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
      bound_doco_id: boundDocoId ?? null,
    };
    file.tokens.push(token);
    await this.save(file);
    return token;
  }

  /** Resolve a session token; returns null if missing or revoked. */
  async resolve(token: string): Promise<SessionToken | null> {
    const file = await this.load();
    const t = file.tokens.find((t) => t.kind === "session" && t.token === token) as
      | SessionToken
      | undefined;
    if (!t || t.revoked) return null;
    // Older rows may not carry bound_doco_id; normalize on read so callers
    // can assume the field exists.
    return { ...t, bound_doco_id: t.bound_doco_id ?? null };
  }

  /**
   * Revoke a session token with strict cascade per ADR-038: every session
   * token whose `invited_by` ancestry passes through this token's principal
   * is also revoked.
   */
  async revoke(token: string, cascade: boolean = true): Promise<number> {
    const file = await this.load();
    let count = 0;
    const target = file.tokens.find((t) => t.kind === "session" && t.token === token) as
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

  // ───────────────────────────────────────────── CLI authorizations

  /**
   * Issue a pending CLI authorization. Returns the row including the
   * state nonce + short code the CLI needs to drive the rest of the
   * flow.
   */
  async issueCliAuthorization(args: {
    cli_version: string;
    cli_hostname: string;
    cli_user_agent: string;
  }): Promise<CliAuthorization> {
    const file = await this.load();
    const now = new Date();
    const row: CliAuthorization = {
      kind: "cli_authorization",
      id: randomBytes(12).toString("hex"),
      state_nonce: randomBytes(TOKEN_LEN_BYTES).toString("hex"),
      short_code: generateShortCode(),
      cli_version: args.cli_version,
      cli_hostname: args.cli_hostname,
      cli_user_agent: args.cli_user_agent,
      status: "pending",
      approved_by_principal_id: null,
      issued_principal_id: null,
      issued_token: null,
      created_doco_handle: null,
      created_doco_id: null,
      approved_owner_username: null,
      created_at: now.toISOString(),
      approved_at: null,
      expires_at: new Date(now.getTime() + CLI_AUTH_TTL_MS).toISOString(),
    };
    file.tokens.push(row);
    await this.save(file);
    return row;
  }

  private async loadAndExpireCliAuthorizations(): Promise<TokenStoreFile> {
    const file = await this.load();
    const now = Date.now();
    let mutated = false;
    for (const t of file.tokens) {
      if (t.kind !== "cli_authorization") continue;
      if (t.status === "pending" && Date.parse(t.expires_at) < now) {
        t.status = "expired";
        mutated = true;
      }
    }
    if (mutated) await this.save(file);
    return file;
  }

  async findCliAuthorizationByState(stateNonce: string): Promise<CliAuthorization | null> {
    const file = await this.loadAndExpireCliAuthorizations();
    const row = file.tokens.find(
      (t) => t.kind === "cli_authorization" && t.state_nonce === stateNonce,
    ) as CliAuthorization | undefined;
    return row ?? null;
  }

  async findCliAuthorizationByShortCode(shortCode: string): Promise<CliAuthorization | null> {
    const file = await this.loadAndExpireCliAuthorizations();
    const row = file.tokens.find(
      (t) => t.kind === "cli_authorization" && t.short_code === shortCode.toUpperCase(),
    ) as CliAuthorization | undefined;
    return row ?? null;
  }

  /**
   * Project owner clicked "Authorize". Mints a session token bound to
   * the supplied agent Principal (which the caller created with
   * owner_id=approvedByPrincipalId), stashes it on the row, and flips
   * status to "approved". The CLI's next poll consumes the token.
   */
  async approveCliAuthorization(
    stateNonce: string,
    approvedByPrincipalId: EntityId<"principal">,
    issuedPrincipalId: EntityId<"principal">,
    sessionTokenValue: string,
    approvedOwnerUsername: string,
    createdDocoHandle: string | null,
    createdDocoId: string | null,
  ): Promise<CliAuthorization> {
    const file = await this.load();
    const row = file.tokens.find(
      (t) => t.kind === "cli_authorization" && t.state_nonce === stateNonce,
    ) as CliAuthorization | undefined;
    if (!row) throw new Error("cli authorization not found");
    if (row.status !== "pending") {
      throw new Error(`cli authorization already in status "${row.status}"`);
    }
    row.status = "approved";
    row.approved_by_principal_id = approvedByPrincipalId;
    row.issued_principal_id = issuedPrincipalId;
    row.issued_token = sessionTokenValue;
    row.approved_owner_username = approvedOwnerUsername;
    row.created_doco_handle = createdDocoHandle;
    row.created_doco_id = createdDocoId;
    row.approved_at = new Date().toISOString();
    await this.save(file);
    return row;
  }

  async denyCliAuthorization(stateNonce: string): Promise<void> {
    const file = await this.load();
    const row = file.tokens.find(
      (t) => t.kind === "cli_authorization" && t.state_nonce === stateNonce,
    ) as CliAuthorization | undefined;
    if (!row) throw new Error("cli authorization not found");
    if (row.status !== "pending") return;
    row.status = "denied";
    await this.save(file);
  }

  /**
   * Single-use exchange: the CLI passes the state nonce, we hand back
   * the token + principal_id and flip status to "exchanged" so a
   * second poll can never re-read the same token.
   */
  async consumeCliAuthorization(stateNonce: string): Promise<{
    token: string;
    principal_id: EntityId<"principal">;
    owner_username: string;
    created_doco_handle: string | null;
    created_doco_id: string | null;
  } | null> {
    const file = await this.load();
    const row = file.tokens.find(
      (t) => t.kind === "cli_authorization" && t.state_nonce === stateNonce,
    ) as CliAuthorization | undefined;
    if (!row) return null;
    if (row.status !== "approved") return null;
    if (!row.issued_token || !row.issued_principal_id || !row.approved_owner_username) {
      throw new Error("cli authorization approved but missing issued token data");
    }
    const out = {
      token: row.issued_token,
      principal_id: row.issued_principal_id,
      owner_username: row.approved_owner_username,
      created_doco_handle: row.created_doco_handle,
      created_doco_id: row.created_doco_id ?? null,
    };
    row.status = "exchanged";
    row.issued_token = null; // wipe the secret after handoff
    await this.save(file);
    return out;
  }

  // ───────────────────────────────────────────── invites

  /**
   * Mint a new Invite for a Doco. Returns the freshly-issued Invite row;
   * the caller renders `invite_url = https://<host>/invite/<code>`.
   *
   * @param docoId             Doco the invite grants access to.
   * @param mintedByPrincipalId Principal that issued the invite (null for the
   *                            anonymous-create seed invite).
   * @param ttlDays             Days until the invite expires (default 7).
   */
  async issueInvite(
    docoId: EntityId<"doco">,
    mintedByPrincipalId: EntityId<"principal"> | null,
    ttlDays: number = 7,
    role: "owner" | "approver" | "author" | "reader" = "author",
    opts: {
      level?: "org" | "doco" | "scope";
      org_id?: EntityId<"organization">;
      scope_id?: EntityId<"scope">;
    } = {},
  ): Promise<Invite> {
    const file = await this.load();
    const now = new Date();
    const expires = new Date(now.getTime() + Math.max(1, Math.min(365, ttlDays)) * 86400 * 1000);
    const level = opts.level ?? "doco";
    const invite: Invite = {
      kind: "invite",
      code: randomBytes(TOKEN_LEN_BYTES).toString("hex"),
      level,
      doco_id: docoId,
      ...(opts.org_id ? { org_id: opts.org_id } : {}),
      ...(opts.scope_id ? { scope_id: opts.scope_id } : {}),
      minted_by_principal_id: mintedByPrincipalId,
      role,
      expires_at: expires.toISOString(),
      issued_at: now.toISOString(),
      status: "pending",
      redeemed_by_principal_id: null,
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
    const row = file.tokens.find(
      (t) => t.kind === "invite" && t.code === code,
    ) as Invite | undefined;
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
    redeemedByPrincipalId: EntityId<"principal">,
  ): Promise<Invite | null> {
    const file = await this.load();
    const row = file.tokens.find(
      (t) => t.kind === "invite" && t.code === code,
    ) as Invite | undefined;
    if (!row) return null;
    if (row.status === "pending" && Date.parse(row.expires_at) < Date.now()) {
      row.status = "expired";
      await this.save(file);
      return null;
    }
    if (row.status !== "pending") return null;
    row.status = "consumed";
    row.redeemed_by_principal_id = redeemedByPrincipalId;
    row.redeemed_at = new Date().toISOString();
    await this.save(file);
    return row;
  }

  async revokeInvite(code: string): Promise<boolean> {
    const file = await this.load();
    const row = file.tokens.find(
      (t) => t.kind === "invite" && t.code === code,
    ) as Invite | undefined;
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

/** Resolve a Bearer token from an Authorization header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? (m[1] ?? "").trim() : null;
}
