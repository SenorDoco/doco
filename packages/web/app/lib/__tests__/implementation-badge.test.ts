import { describe, expect, it } from "vitest";
import { IMPLEMENTATION_INDICATOR_TYPES, implementationBadgeSpec } from "../implementation-badge";

// The BPMN perspective shows a gear (implemented) or a light bulb (not
// implemented) on the process "event" nodes. Scope per project owner:
// Actions, Decisions, States, Rules, and Evals. References (which ARE the
// implementation) and Ideas (whose type icon is already a light bulb) are
// excluded.
const IN_SCOPE = ["action", "decision", "state", "rule", "eval"] as const;
const OUT_OF_SCOPE = ["reference", "idea", "intent", "principal", "log", "doco"] as const;

describe("implementationBadgeSpec", () => {
  it("scopes the indicator to process steps + policies", () => {
    expect([...IMPLEMENTATION_INDICATOR_TYPES].sort()).toEqual([...IN_SCOPE].sort());
  });

  it("returns null for node types that carry no indicator", () => {
    for (const type of OUT_OF_SCOPE) {
      expect(implementationBadgeSpec(type, true)).toBeNull();
      expect(implementationBadgeSpec(type, false)).toBeNull();
    }
  });

  it("renders a white gear for an implemented in-scope node", () => {
    for (const type of IN_SCOPE) {
      const spec = implementationBadgeSpec(type, true);
      expect(spec).not.toBeNull();
      expect(spec?.status).toBe("implemented");
      // The gear is white.
      expect(spec?.color.toLowerCase()).toBe("#ffffff");
      // The tooltip explains what the icon means.
      expect(spec?.title).toMatch(/implemented/i);
      expect(spec?.title).not.toMatch(/not implemented/i);
    }
  });

  it("renders a yellow light bulb for an unimplemented in-scope node", () => {
    for (const type of IN_SCOPE) {
      const spec = implementationBadgeSpec(type, false);
      expect(spec).not.toBeNull();
      expect(spec?.status).toBe("not_implemented");
      // A light bulb in a recognizably-yellow hue.
      expect(spec?.color.toLowerCase()).toBe("#facc15");
      expect(spec?.title).toMatch(/not implemented/i);
    }
  });

  it("treats missing implementation info as not implemented", () => {
    expect(implementationBadgeSpec("action", null)?.status).toBe("not_implemented");
    expect(implementationBadgeSpec("action", undefined)?.status).toBe("not_implemented");
  });
});
