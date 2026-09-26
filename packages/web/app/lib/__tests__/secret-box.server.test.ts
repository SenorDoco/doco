import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "../secret-box.server";

const KEY = randomBytes(32).toString("base64");

beforeEach(() => {
  process.env.DOCO_ENCRYPTION_KEY = KEY;
});
afterEach(() => {
  process.env.DOCO_ENCRYPTION_KEY = undefined;
});

describe("secret box", () => {
  it("round-trips a secret, and the stored form never contains it", () => {
    const stored = encryptSecret("xoxb-live-token");
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(stored).not.toContain("xoxb");
    expect(decryptSecret(stored)).toBe("xoxb-live-token");
  });

  it("uses a fresh IV each time", () => {
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("rejects a tampered ciphertext", () => {
    const stored = encryptSecret("xoxb-live-token");
    const [head, tag, body] = stored.split(".");
    const flipped = Buffer.from(body, "base64url");
    flipped[0] ^= 1;
    expect(() => decryptSecret(`${head}.${tag}.${flipped.toString("base64url")}`)).toThrow();
  });

  it("rejects decryption under a different key", () => {
    const stored = encryptSecret("xoxb-live-token");
    process.env.DOCO_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptSecret(stored)).toThrow();
  });

  it("refuses to run without a 32-byte key", () => {
    process.env.DOCO_ENCRYPTION_KEY = "too-short";
    expect(() => encryptSecret("x")).toThrow(/DOCO_ENCRYPTION_KEY/);
  });

  it("does not mistake a plaintext token for an encrypted one", () => {
    expect(isEncryptedSecret("xoxb-123")).toBe(false);
  });
});
