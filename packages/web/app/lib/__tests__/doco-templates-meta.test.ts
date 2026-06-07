import { describe, expect, it } from "vitest";
import { DOCO_TEMPLATES, findDocoTemplateMeta } from "../doco-templates-meta";

// The picker offers the blank `generic` start, `process`,
// `github-pull-requests`, the four decision-record templates, `glossary`,
// `org-chart`, `product-roadmap`, and `bugs`. The glossary concept returned as the
// singular `glossary` (reshaped around References) and `org-chart` returned as
// the abstraction for documenting org structure; only the plural `glossaries`
// handle stays removed.
const SURVIVING_HANDLES = [
  "generic",
  "process",
  "github-pull-requests",
  "architectural-decisions",
  "product-decisions",
  "design-decisions",
  "data-decisions",
  "glossary",
  "org-chart",
  "product-roadmap",
  "bugs",
] as const;

const REMOVED_HANDLES = ["glossaries"] as const;

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
