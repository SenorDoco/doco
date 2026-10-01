import { describe, expect, it } from "vitest";
import { DOCO_TEMPLATES, findDocoTemplateMeta } from "../doco-templates-meta";

// The picker offers the blank `generic` start, `process`,
// `github-pull-requests`, the three decision-record templates, `glossary`,
// `org-chart`, `evals`, `product-roadmap`, `test-scenarios`, `faq`, and `bugs`. The
// glossary concept returned as the singular `glossary` (reshaped around
// References), `org-chart` returned as the abstraction for documenting org
// structure, and `faq` documents a question-and-answer knowledge base alongside
// the log of each result. The `data-decisions` flavor folded into
// `architectural-decisions`, which now subsumes data-modeling, storage, and
// governance decisions; the plural `glossaries` handle stays removed too.
const SURVIVING_HANDLES = [
  "generic",
  "process",
  "github-pull-requests",
  "github-bugs",
  "codebase",
  "slack",
  "notion",
  "architectural-decisions",
  "product-decisions",
  "design-decisions",
  "glossary",
  "org-chart",
  "evals",
  "product-roadmap",
  "test-scenarios",
  "faq",
  "bugs",
  "ideas",
  "agents-chats",
] as const;

const REMOVED_HANDLES = ["glossaries", "data-decisions"] as const;

describe("doco template metadata", () => {
  it("exposes exactly the surviving templates in the picker metadata", () => {
    expect(DOCO_TEMPLATES.map((template) => template.handle).sort()).toEqual(
      [...SURVIVING_HANDLES].sort(),
    );
  });

  // The /new-doco picker shows them in this order: the blank start first, then
  // every other template A to Z by label, so a template is easy to find.
  it("lists Generic first, then the rest A to Z by label", () => {
    const [first, ...rest] = DOCO_TEMPLATES.map((template) => template.label);
    expect(first).toBe("Generic (empty)");
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b, "en")));
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
