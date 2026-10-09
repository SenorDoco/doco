// Authenticated encryption (AES-256-GCM) for third-party credentials stored in
// Postgres, so a database dump alone never yields a working token, and for the
// tokens the server issues and later trusts (sealToken): sign-in sessions,
// OAuth states, invite cookies. Only this key can make one that opens, so the
// encryption is also the signature.
//
// Key: DOCO_ENCRYPTION_KEY — 32 random bytes, base64 (`openssl rand -base64 32`).
// Stored form: `v1:<iv>.<auth tag>.<ciphertext>`, each part base64url.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const PREFIX = "v1:";

function encryptionKey(): Buffer {
  const key = Buffer.from(process.env.DOCO_ENCRYPTION_KEY ?? "", "base64");
  if (key.length !== 32) {
    throw new Error(
      "DOCO_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).",
    );
  }
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return `${PREFIX}${[iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".")}`;
}

export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Throws if `stored` was tampered with or encrypted under another key. */
export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) throw new Error("Not an encrypted secret.");
  const [iv, tag, ciphertext] = stored
    .slice(PREFIX.length)
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !ciphertext) throw new Error("Malformed encrypted secret.");
  // The full 16-byte tag, always: Node otherwise accepts a tag cut down to 4
  // bytes, which would make forging a token a matter of guessing.
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/** A token only this server can make: `value` sealed with the key, readable
 *  by `openToken` for `ttlMs`. */
export function sealToken(value: unknown, ttlMs: number, now = Date.now()): string {
  return encryptSecret(JSON.stringify([value, now + ttlMs]));
}

/** The value `sealToken` sealed, or null when the token is forged, tampered
 *  with, sealed under another key, or expired. Throws without a key, so a
 *  misconfigured server fails loudly instead of trusting no one quietly. */
export function openToken(token: string, now = Date.now()): unknown {
  encryptionKey();
  try {
    const [value, expiresAt] = JSON.parse(decryptSecret(token)) as unknown[];
    return typeof expiresAt === "number" && now < expiresAt ? value : null;
  } catch {
    return null;
  }
}
