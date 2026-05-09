import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { EntityId } from "@evalo/shared";

/**
 * Token store. Phase 4 ships a local JSON file under `.evalo/tokens.json`
 * (NOT committed to git per ADR-039). Phase 6 swaps this out for a managed
 * encrypted DB on the SaaS side; the interface stays the same.
 *
 * The local-mode default behavior: if EVALO_LOCAL_PRINCIPAL_ID is set in env,
 * unauthenticated requests are accepted as that principal. This is the
 * "trusted localhost" mode for solo dev. Production deployments should set
 * EVALO_REQUIRE_TOKEN=true.
 */

export interface SessionToken {
  token: string; // opaque, random
  principal_id: EntityId<"principal">;
  issued_at: string;
  expires_at?: string | null;
  invited_by?: EntityId<"principal"> | null;
  revoked: boolean;
}

interface TokenStoreFile {
  schema_version: 1;
  tokens: SessionToken[];
}

const TOKEN_LEN_BYTES = 32; // 256 bits → 64 hex chars

export class TokenStore {
  constructor(private readonly path: string) {}

  static forEvalo(evaloRoot: string): TokenStore {
    return new TokenStore(join(evaloRoot, ".evalo", "tokens.json"));
  }

  async load(): Promise<TokenStoreFile> {
    if (!existsSync(this.path)) {
      return { schema_version: 1, tokens: [] };
    }
    const text = await readFile(this.path, "utf8");
    return JSON.parse(text) as TokenStoreFile;
  }

  async save(file: TokenStoreFile): Promise<void> {
    await writeFile(this.path, JSON.stringify(file, null, 2), "utf8");
  }

  async issueSessionToken(principalId: EntityId<"principal">, invitedBy?: EntityId<"principal">): Promise<SessionToken> {
    const file = await this.load();
    const token: SessionToken = {
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

  async resolve(token: string): Promise<SessionToken | null> {
    const file = await this.load();
    const t = file.tokens.find((t) => t.token === token && !t.revoked);
    return t ?? null;
  }

  async revoke(token: string, cascade: boolean = true): Promise<number> {
    const file = await this.load();
    let count = 0;
    const matches = file.tokens.find((t) => t.token === token);
    if (!matches) return 0;
    matches.revoked = true;
    count = 1;
    if (cascade) {
      // Strict cascade per ADR-038: revoke any token whose ancestry chain passes through this one.
      const chain = new Set<EntityId<"principal">>([matches.principal_id]);
      let added = true;
      while (added) {
        added = false;
        for (const t of file.tokens) {
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
}

/** Resolve a Bearer token from an Authorization header. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? (m[1] ?? "").trim() : null;
}
