import { describe, expect, it } from "vitest";
import { agentName, formatAuthoringMechanism } from "../authoring-provenance";

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

describe("formatAuthoringMechanism without a recorded request", () => {
  // Every request records how it arrived (auth or surface); a write with
  // neither came from Doco itself, such as the GitHub import.
  it("names an API-source write with no request context an import", () => {
    expect(formatAuthoringMechanism("api", null)).toBe("Import");
  });

  it("keeps naming token-less API requests API", () => {
    expect(formatAuthoringMechanism("api", { auth: "bearer" })).toBe("API");
  });
});

describe("agentName", () => {
  it("is null for the website itself", () => {
    expect(agentName("ui", { surface: "website" })).toBeNull();
  });

  it("names the token an agent connected with", () => {
    expect(agentName("api", { auth: "oauth", token_name: "Claude Code" })).toBe("Claude Code");
  });

  it("names Señor Doco, which is an agent even on the website", () => {
    expect(agentName("ui", { surface: "senor_doco", client: "website" })).toBe(
      "Señor Doco on website",
    );
  });
});
