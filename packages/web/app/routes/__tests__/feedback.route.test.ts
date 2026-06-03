import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentPrincipal: vi.fn(),
  listFeedbackReports: vi.fn(),
  countPendingFeedback: vi.fn(),
  clearFeedbackReports: vi.fn(),
}));

vi.mock("~/lib/session.server", () => ({ getCurrentPrincipal: mocks.getCurrentPrincipal }));
vi.mock("~/lib/feedback-reports.server", () => ({
  listFeedbackReports: mocks.listFeedbackReports,
  countPendingFeedback: mocks.countPendingFeedback,
  clearFeedbackReports: mocks.clearFeedbackReports,
}));

import { action, loader, meta } from "../feedback";

function get(): Request {
  return new Request("https://doco.to/feedback");
}

function postForm(fields: Record<string, string>): Request {
  return new Request("https://doco.to/feedback", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("/feedback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_t", username: "torrenegra" });
    mocks.listFeedbackReports.mockResolvedValue([]);
    mocks.countPendingFeedback.mockResolvedValue({ bugs: 0, ideas: 0 });
    mocks.clearFeedbackReports.mockResolvedValue(0);
  });

  it("is titled just Feedback — not mentor feedback", () => {
    expect(meta()).toEqual([{ title: "Feedback · Doco" }]);
  });

  it("loader redirects signed-out visitors to sign-in with next=/feedback", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue(null);
    const res = (await loader({ request: get() }).catch((e: unknown) => e)) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/sign-in?next=%2Ffeedback");
  });

  it("loader 404s for anyone who is not the owner", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_x", username: "someone" });
    await expect(loader({ request: get() })).rejects.toMatchObject({ status: 404 });
    expect(mocks.listFeedbackReports).not.toHaveBeenCalled();
  });

  it("loader surfaces authoritative pending counts plus a cleared tally", async () => {
    mocks.countPendingFeedback.mockResolvedValue({ bugs: 3, ideas: 2 });
    mocks.listFeedbackReports.mockResolvedValue([
      { id: "feedback_1", report_type: "bug", status: "new" },
      { id: "feedback_2", report_type: "idea", status: "archived" },
    ]);
    const data = await loader({ request: get() });
    expect(data.counts).toEqual({ total: 2, bugs: 3, ideas: 2, cleared: 1 });
  });

  it("action clears bugs as the owner and redirects back to /feedback", async () => {
    const res = await action({ request: postForm({ intent: "clear", report_type: "bug" }) });
    expect(mocks.clearFeedbackReports).toHaveBeenCalledWith("bug", "user_t");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/feedback");
  });

  it("action clears ideas as the owner", async () => {
    await action({ request: postForm({ intent: "clear", report_type: "idea" }) });
    expect(mocks.clearFeedbackReports).toHaveBeenCalledWith("idea", "user_t");
  });

  it("action treats a missing/unknown report_type as clear-all", async () => {
    await action({ request: postForm({ intent: "clear" }) });
    expect(mocks.clearFeedbackReports).toHaveBeenCalledWith("all", "user_t");
  });

  it("action ignores intents other than clear", async () => {
    const res = await action({ request: postForm({ intent: "noop" }) });
    expect(mocks.clearFeedbackReports).not.toHaveBeenCalled();
    expect(res.status).toBe(302);
  });

  it("action 404s for non-owners and clears nothing", async () => {
    mocks.getCurrentPrincipal.mockResolvedValue({ id: "user_x", username: "someone" });
    await expect(
      action({ request: postForm({ intent: "clear", report_type: "bug" }) }),
    ).rejects.toMatchObject({ status: 404 });
    expect(mocks.clearFeedbackReports).not.toHaveBeenCalled();
  });
});
