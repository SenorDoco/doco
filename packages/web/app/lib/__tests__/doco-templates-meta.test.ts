import { describe, expect, it } from "vitest";
import { DOCO_TEMPLATES, findDocoTemplateMeta } from "../doco-templates-meta";

const DECISION_RECORD_HANDLES = [
  "architectural-decisions",
  "product-decisions",
  "design-decisions",
  "data-decisions",
] as const;

describe("doco template metadata", () => {
  it("exposes the decision-record templates in the picker metadata", () => {
    const handles = DOCO_TEMPLATES.map((template) => template.handle);
    for (const handle of DECISION_RECORD_HANDLES) {
      expect(handles).toContain(handle);
      const meta = findDocoTemplateMeta(handle);
      expect(meta?.label).toMatch(/Decisions/);
      expect(meta?.description).toMatch(/decision records/i);
      expect(meta?.updatedAt).toBe("2026-05-31");
    }
  });

  it("marks the Glossaries template metadata as updated when its guidance changes", () => {
    const meta = findDocoTemplateMeta("glossaries");
    expect(meta?.updatedAt).toBe("2026-06-03");
  });

  it("describes Glossaries with replacements separate from aliases", () => {
    const meta = findDocoTemplateMeta("glossaries");
    expect(meta?.description).toMatch(/aliases/i);
    expect(meta?.description).toMatch(/replacement links/i);
    expect(meta?.description).not.toMatch(/deprecated wording/i);
  });
});
