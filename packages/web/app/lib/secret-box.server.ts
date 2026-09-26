// Authenticated encryption (AES-256-GCM) for third-party credentials stored in
// Postgres, so a database dump alone never yields a working token.
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
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
