import { describe, expect, it } from "vitest";
import type { Brief } from "../brief";
import { type BriefEvaluationCase, scoreEvidenceDelivery } from "../evaluate";

const evaluationCase: BriefEvaluationCase = {
  id: "shipping-workflow",
  kind: "gold",
  about: "How should I ship this change?",
  required: ["rule_active", "decision_release"],
  forbidden: ["rule_retired"],
  mustObey: ["rule_active"],
};

function brief(
  items: Array<{ id: string; tier: Brief["items"][number]["tier"] }>,
  tokensUsed = 900,
  budget = 4_000,
): Pick<Brief, "budget" | "items" | "tokens_used"> {
  return {
    budget,
    tokens_used: tokensUsed,
    items: items.map(({ id, tier }) => ({
      id,
      tier,
      type: id.split("_", 1)[0],
      doco: "decisions",
      lifecycle: "active",
      summary: id,
      text: id,
      because: "test evidence",
      url: null,
      updated_at: null,
      detail: "expanded",
    })),
  };
}

describe("scoreEvidenceDelivery", () => {
  it("passes when every required record arrives, mandatory evidence is in its tier, and the budget holds", () => {
    expect(
      scoreEvidenceDelivery(
        evaluationCase,
        brief([
          { id: "rule_active", tier: "must_obey" },
          { id: "decision_release", tier: "decided" },
        ]),
      ),
    ).toEqual({
      passed: true,
      requiredMissing: [],
      forbiddenServed: [],
      mustObeyViolations: [],
      duplicateIds: [],
      budgetExceededBy: 0,
    });
  });

  it("names every evidence-delivery contract violation", () => {
    expect(
      scoreEvidenceDelivery(
        evaluationCase,
        brief(
          [
            { id: "rule_active", tier: "decided" },
            { id: "rule_retired", tier: "decided" },
            { id: "rule_retired", tier: "decided" },
          ],
          4_125,
        ),
      ),
    ).toEqual({
      passed: false,
      requiredMissing: ["decision_release"],
      forbiddenServed: ["rule_retired"],
      mustObeyViolations: ["rule_active"],
      duplicateIds: ["rule_retired"],
      budgetExceededBy: 125,
    });
  });
});
