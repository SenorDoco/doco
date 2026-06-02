import { describe, expect, it } from "vitest";
import { GRANT_REQUIRED_MESSAGE, validateGrantForm } from "../grant-form-validation";

const NAME = { value: "", message: "Enter a name for this token." };

describe("validateGrantForm", () => {
  it("returns no errors when name and at least one grant are present", () => {
    expect(validateGrantForm({ name: { ...NAME, value: "Codex" }, grantCount: 1 })).toEqual([]);
  });

  it("requires at least one grant even when there is no name field", () => {
    expect(validateGrantForm({ grantCount: 0 })).toEqual([
      { field: "grants", message: GRANT_REQUIRED_MESSAGE },
    ]);
  });

  it("passes a grants-only form once a grant is selected", () => {
    expect(validateGrantForm({ grantCount: 2 })).toEqual([]);
  });

  it("flags a missing name with the caller-supplied message", () => {
    expect(validateGrantForm({ name: NAME, grantCount: 1 })).toEqual([
      { field: "name", message: NAME.message },
    ]);
  });

  it("treats a whitespace-only name as missing", () => {
    const errors = validateGrantForm({ name: { ...NAME, value: "   " }, grantCount: 1 });
    expect(errors.map((e) => e.field)).toEqual(["name"]);
  });

  it("reports the name first so it is the scroll/focus target when both are invalid", () => {
    const errors = validateGrantForm({ name: NAME, grantCount: 0 });
    expect(errors.map((e) => e.field)).toEqual(["name", "grants"]);
  });
});
