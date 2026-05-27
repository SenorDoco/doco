import { describe, expect, it } from "vitest";
import { parseFeedbackReportInput } from "../feedback-reports.server";

describe("parseFeedbackReportInput", () => {
  it("accepts bug reports with captured page context", () => {
    const result = parseFeedbackReportInput({
      report_type: "bug",
      title: "Invite button exploded",
      body: "I clicked the button and got a server error.",
      expected: "An invite link",
      actual: "Unexpected Server Error",
      severity: "high",
      page_url: "https://doco.test/collaborators",
      route_path: "/collaborators",
      client_context: {
        viewport: { width: 1440, height: 900 },
        activity: {
          recent: [
            {
              kind: "click",
              target: { tag: "button", text: "Generate invite link" },
              page: { pathname: "/collaborators" },
            },
          ],
        },
      },
      data: { form_version: 1 },
    });

    expect(result).toMatchObject({
      report_type: "bug",
      title: "Invite button exploded",
      severity: "high",
      route_path: "/collaborators",
      client_context: {
        viewport: { width: 1440, height: 900 },
        activity: {
          recent: [
            {
              kind: "click",
              target: { tag: "button", text: "Generate invite link" },
              page: { pathname: "/collaborators" },
            },
          ],
        },
      },
    });
  });

  it("requires a bug or idea type and some human text", () => {
    expect(parseFeedbackReportInput({ report_type: "question", body: "hi" })).toEqual({
      error: "Pick bug or idea.",
    });
    expect(parseFeedbackReportInput({ report_type: "idea" })).toEqual({
      error: "Add a title or a few details.",
    });
  });
});
