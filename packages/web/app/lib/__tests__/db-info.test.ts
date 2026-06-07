import { describe, expect, it } from "vitest";

import { summarizeDatabaseUrl } from "../db-info.server";

describe("summarizeDatabaseUrl", () => {
  it("never leaks the password and masks it in the rebuilt url", () => {
    const s = summarizeDatabaseUrl(
      "postgres://neonuser:s3cr3t-pw@ep-cool-frog-123.us-east-2.aws.neon.tech/desko?sslmode=require",
    );
    // The password must not appear anywhere in the returned object.
    expect(JSON.stringify(s)).not.toContain("s3cr3t-pw");
    expect(s.redactedUrl).toBe(
      "postgres://neonuser:***@ep-cool-frog-123.us-east-2.aws.neon.tech/desko?sslmode=require",
    );
    expect(s.hasPassword).toBe(true);
  });

  it("parses host/port/database/user and detects the Neon provider", () => {
    const s = summarizeDatabaseUrl(
      "postgres://u:p@ep-x.us-east-2.aws.neon.tech:5432/desko_db?sslmode=require",
    );
    expect(s.host).toBe("ep-x.us-east-2.aws.neon.tech");
    expect(s.port).toBe("5432");
    expect(s.database).toBe("desko_db");
    expect(s.user).toBe("u");
    expect(s.provider).toBe("neon");
    expect(s.params).toEqual({ sslmode: "require" });
  });

  it("flags Neon pooled endpoints", () => {
    const s = summarizeDatabaseUrl("postgres://u:p@ep-x-pooler.us-east-2.aws.neon.tech/db");
    expect(s.pooled).toBe(true);
  });

  it("recognizes the local dev fallback", () => {
    const s = summarizeDatabaseUrl("postgres://postgres:doco@127.0.0.1:5433/doco");
    expect(s.provider).toBe("local");
    expect(s.redactedUrl).toBe("postgres://postgres:***@127.0.0.1:5433/doco");
  });

  it("does not crash on an unparseable connection string", () => {
    const s = summarizeDatabaseUrl("not a url");
    expect(s.host).toBeNull();
    expect(s.provider).toBe("unknown");
    expect(s.hasPassword).toBe(false);
  });
});
