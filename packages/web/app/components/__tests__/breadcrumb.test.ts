import { describe, expect, it } from "vitest";
import { docoBreadcrumb } from "../breadcrumb";

describe("docoBreadcrumb", () => {
  it("keeps Home and the owning organization in doco-scoped trails", () => {
    expect(docoBreadcrumb({ ownerSlug: "torre", handle: "meta-pull-requests" })).toEqual([
      { label: "Home", to: "/" },
      { label: "torre", to: "/orgs/torre" },
      { label: "meta-pull-requests", to: "/meta-pull-requests" },
    ]);
  });

  it("appends parent and page labels after the Doco", () => {
    expect(
      docoBreadcrumb({
        ownerSlug: "torre",
        handle: "meta-pull-requests",
        parent: { label: "Policies", to: "/meta-pull-requests/policies" },
        pageLabel: "Guidance",
      }),
    ).toEqual([
      { label: "Home", to: "/" },
      { label: "torre", to: "/orgs/torre" },
      { label: "meta-pull-requests", to: "/meta-pull-requests" },
      { label: "Policies", to: "/meta-pull-requests/policies" },
      { label: "Guidance" },
    ]);
  });
});
