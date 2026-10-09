import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  openToken,
  sealToken,
} from "../secret-box.server";

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

describe("sealed tokens", () => {
  const now = Date.UTC(2026, 9, 9, 12);

  it("open to the value they sealed until they expire", () => {
    const token = sealToken({ userId: "user_1" }, 60_000, now);
    expect(openToken(token, now + 59_999)).toEqual({ userId: "user_1" });
    expect(openToken(token, now + 60_000)).toBeNull();
  });

  it("never show the value they carry", () => {
    expect(sealToken("user_1", 60_000, now)).not.toContain("user_1");
  });

  it("open to nothing when tampered with, sealed under another key, or never sealed", () => {
    const [head, , body] = sealToken("user_1", 60_000, now).split(".");
    const otherTag = randomBytes(16).toString("base64url");
    expect(openToken(`${head}.${otherTag}.${body}`, now)).toBeNull();
    expect(openToken("user_1", now)).toBeNull();
    expect(openToken("v1:not.a.token", now)).toBeNull();

    const token = sealToken("user_1", 60_000, now);
    process.env.DOCO_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(openToken(token, now)).toBeNull();
  });

  it("open to nothing with a truncated tag, which would make a forgery guessable", () => {
    const [head, tag, body] = sealToken("user_1", 60_000, now).split(".");
    const short = Buffer.from(tag ?? "", "base64url")
      .subarray(0, 4)
      .toString("base64url");
    expect(openToken(`${head}.${short}.${body}`, now)).toBeNull();
  });

  it("refuse to open without a 32-byte key, so a missing key fails loudly", () => {
    process.env.DOCO_ENCRYPTION_KEY = "too-short";
    expect(() => openToken("user_1", now)).toThrow(/DOCO_ENCRYPTION_KEY/);
  });
});
