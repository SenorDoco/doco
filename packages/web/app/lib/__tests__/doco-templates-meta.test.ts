import { describe, expect, it } from "vitest";
import { DOCO_TEMPLATES, findDocoTemplateMeta } from "../doco-templates-meta";

// The glossaries and four decision-record templates were removed; the picker
// offers the blank `generic` start, `process`, `github-pull-requests`, and the
// `org-chart` (reintroduced as the abstraction for documenting org structure).
const SURVIVING_HANDLES = ["generic", "process", "github-pull-requests", "org-chart"] as const;

const REMOVED_HANDLES = [
  "glossaries",
  "architectural-decisions",
  "product-decisions",
  "design-decisions",
  "data-decisions",
] as const;

describe("doco template metadata", () => {
  it("exposes exactly the surviving templates in the picker metadata", () => {
    expect(DOCO_TEMPLATES.map((template) => template.handle)).toEqual([...SURVIVING_HANDLES]);
  });

  it("resolves each surviving handle to non-empty metadata", () => {
    for (const handle of SURVIVING_HANDLES) {
      const meta = findDocoTemplateMeta(handle);
      expect(meta?.handle).toBe(handle);
      expect(meta?.label).toBeTruthy();
      expect(meta?.description).toBeTruthy();
    }
  });

  it("no longer exposes the removed templates", () => {
    const handles = DOCO_TEMPLATES.map((template) => template.handle);
    for (const handle of REMOVED_HANDLES) {
      expect(handles).not.toContain(handle);
      expect(findDocoTemplateMeta(handle)).toBeUndefined();
    }
  });
});
