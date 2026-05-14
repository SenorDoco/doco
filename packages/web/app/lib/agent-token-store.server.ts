import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EntityId } from "@doco/shared";

/**
 * Token store. Holds session tokens (no default expiry, revocable, ADR-038)
 * and CLI authorization rows (decision_01KRKZM14WNA1685GN0F12WCKM). One
 * file per Host; not committed to git per ADR-039.
 */

export type StoredToken = SessionToken | CliAuthorization;

export interface SessionToken {
  kind: "session";
  token: string; // opaque, 256 bits hex
  principal_id: EntityId<"principal">;
  issued_at: string;
  expires_at: string | null; // null = never (sessions; ADR-037)
  invited_by: EntityId<"principal"> | null; // chain root reached at a person (ADR-035 invariant)
  revoked: boolean;
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
  created_doco_slug: string | null;
  /** The owner_slug under which Docos created in this session live. */
  approved_owner_slug: string | null;
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
    if (process.env.DOCO_STORAGE === "postgres") {
      const { withClient } = await import("@doco/db");
      const r = await withClient((c) =>
        c.query<{ blob: TokenStoreFile }>(
          "SELECT blob FROM tokens_blob WHERE key = $1 LIMIT 1",
          [this.path],
        ),
      );
      if (!r.rows[0]) return { schema_version: 2, tokens: [] };
      // pg returns jsonb as already-parsed object.
      const parsed = r.rows[0].blob as unknown as { schema_version: number; tokens: unknown[] };
      const tokens: StoredToken[] = parsed.tokens.map((t) => {
        const tok = t as Record<string, unknown>;
        if (!tok.kind) return { ...tok, kind: "session" } as unknown as SessionToken;
        return tok as unknown as StoredToken;
      });
      return { schema_version: 2, tokens };
    }
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
    if (process.env.DOCO_STORAGE === "postgres") {
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
      return;
    }
    await mkdir(dirname(this.path), { recursive: true });
    await writeFile(this.path, JSON.stringify(file, null, 2), "utf8");
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
    const t = file.tokens.find((t) => t.kind === "session" && t.token === token) as
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
      created_doco_slug: null,
      approved_owner_slug: null,
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
    approvedOwnerSlug: string,
    createdDocoSlug: string | null,
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
    row.approved_owner_slug = approvedOwnerSlug;
    row.created_doco_slug = createdDocoSlug;
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
    owner_slug: string;
    created_doco_slug: string | null;
  } | null> {
    const file = await this.load();
    const row = file.tokens.find(
      (t) => t.kind === "cli_authorization" && t.state_nonce === stateNonce,
    ) as CliAuthorization | undefined;
    if (!row) return null;
    if (row.status !== "approved") return null;
    if (!row.issued_token || !row.issued_principal_id || !row.approved_owner_slug) {
      throw new Error("cli authorization approved but missing issued token data");
    }
    const out = {
      token: row.issued_token,
      principal_id: row.issued_principal_id,
      owner_slug: row.approved_owner_slug,
      created_doco_slug: row.created_doco_slug,
    };
    row.status = "exchanged";
    row.issued_token = null; // wipe the secret after handoff
    await this.save(file);
    return out;
  }

}

/** Resolve a Bearer token from an Authorization header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? (m[1] ?? "").trim() : null;
}
