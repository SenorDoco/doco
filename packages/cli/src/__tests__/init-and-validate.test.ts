import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SchemaValidator, loadDoco, validateDoco } from "@doco/core";
import { initCmd } from "../commands/init.js";

let tmp: string;
let originalCwd: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "doco-init-"));
  originalCwd = process.cwd();
  process.chdir(tmp);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmp, { recursive: true, force: true });
});

describe("doco init + validate end-to-end", () => {
  it("creates a new Doco that passes validation", async () => {
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
    const loaded = await loadDoco(root);
    expect(loaded.doco.slug).toBe("test/my-project");
    expect(loaded.byType.get("principal")?.length).toBe(1);
    expect(loaded.failures).toEqual([]);

    const validator = await SchemaValidator.load(root);
    const report = await validateDoco(loaded, validator);
    expect(report.ok).toBe(true);
    expect(report.totalEntities).toBe(1); // just the owner Principal
  });
});
