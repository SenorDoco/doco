import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaValidator, loadEvalo, validateEvalo } from "@evalo/core";
import { initCmd } from "../commands/init.js";

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "evalo-init-"));
  originalCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
});

describe("evalo init + validate end-to-end", () => {
  it("creates a new Evalo that passes validation", async () => {
    // Run the init command's handler directly (bypassing the CLI parser).
    await initCmd.run!({
      args: {
        slug: "test/my-project",
        "owner-username": "tester",
        "owner-email": "tester@example.com",
        visibility: "private",
        existing: false,
        _: [],
      } as never,
      rawArgs: [],
      cmd: initCmd,
      data: {},
    });

    const root = join(tmp, "my-project");
    const loaded = await loadEvalo(root);
    expect(loaded.evalo.slug).toBe("test/my-project");
    expect(loaded.byType.get("principal")?.length).toBe(1);
    expect(loaded.failures).toEqual([]);

    const validator = await SchemaValidator.load(root);
    const report = await validateEvalo(loaded, validator);
    expect(report.ok).toBe(true);
    expect(report.totalEntities).toBe(1); // just the owner Principal
  });
});
