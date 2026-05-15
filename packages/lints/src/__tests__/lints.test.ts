import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { withClient } from "@doco/db";
import { reindex } from "@doco/index";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { runAllLints } from "../index.js";

const REPO_ROOT = resolve(__dirname, "../../../../docos/torrenegra/doco");

function readDocoId(): string {
  const fm = parseYaml(readFileSync(join(REPO_ROOT, "doco.yaml"), "utf8")) as {
    id: string;
  };
  return fm.id;
}

describe("system lints against the Doco project (PG-backed)", () => {
  it("reports zero errors", async () => {
    await reindex(REPO_ROOT);
    const docoId = readDocoId();
    const report = await withClient((c) => runAllLints(c, docoId));
    expect(report.errors).toBe(0);
  });

  it("agent-ancestry: claude is owned by a person — passes", async () => {
    await reindex(REPO_ROOT);
    const docoId = readDocoId();
    const report = await withClient((c) => runAllLints(c, docoId));
    expect(report.issuesByLint["agent-ancestry"] ?? []).toEqual([]);
  });

  it("orphan-reasoning: bootstrap reasoning has a real conclusion_ref", async () => {
    await reindex(REPO_ROOT);
    const docoId = readDocoId();
    const report = await withClient((c) => runAllLints(c, docoId));
    expect(report.issuesByLint["orphan-reasoning"] ?? []).toEqual([]);
  });

  it("follows-cycle: meta-Doco has no follows cycles", async () => {
    await reindex(REPO_ROOT);
    const docoId = readDocoId();
    const report = await withClient((c) => runAllLints(c, docoId));
    expect(report.issuesByLint["follows-cycle"] ?? []).toEqual([]);
  });
});
