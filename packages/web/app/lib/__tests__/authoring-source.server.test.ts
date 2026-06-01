import { describe, expect, it } from "vitest";
import { AUTHORING_SURFACE_HEADER, authoringContextForRequest } from "../authoring-source.server";

describe("authoringContextForRequest", () => {
  it("classifies normal browser writes as website authoring", () => {
    const request = new Request("https://doco.test/acme/api/decisions.json", {
      headers: { Cookie: "doco_session=user_01TEST" },
    });

    expect(authoringContextForRequest(request)).toEqual({
      source: "ui",
      metadata: { surface: "website" },
    });
  });

  it("classifies in-page Señor Doco writes separately from plain website writes", () => {
    const request = new Request("https://doco.test/acme/api/decisions.json", {
      headers: {
        Cookie: "doco_session=user_01TEST",
        [AUTHORING_SURFACE_HEADER]: "senor-doco-web",
      },
    });

    expect(authoringContextForRequest(request)).toEqual({
      source: "ui",
      metadata: { surface: "senor_doco", client: "website" },
    });
  });

  it("classifies OAuth bearer writes as API authoring", () => {
    const request = new Request("https://doco.test/acme/api/decisions.json", {
      headers: { Authorization: "Bearer doco_at_test" },
    });

    expect(authoringContextForRequest(request)).toEqual({
      source: "api",
      metadata: { auth: "oauth" },
    });
  });
});
