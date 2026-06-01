import { describe, expect, it } from "vitest";
import { formatAuthoringMechanism } from "../authoring-provenance";

describe("formatAuthoringMechanism", () => {
  it("shows the OAuth token name for API-authored writes", () => {
    expect(
      formatAuthoringMechanism("api", {
        auth: "oauth",
        token_name: "Authoring Verification Token",
      }),
    ).toBe("Authoring Verification Token");
  });
});
