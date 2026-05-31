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
});
