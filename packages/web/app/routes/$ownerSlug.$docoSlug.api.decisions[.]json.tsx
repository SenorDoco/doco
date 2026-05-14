import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { captureDecision, type DecisionDraft } from "~/lib/capture.server";

const route = makeCaptureRoute<DecisionDraft>({
  type: "decisions",
  captureFn: captureDecision,
  fillFromAuth: (draft, me) => {
    if (!draft.decided_by_username) draft.decided_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  },
});

export const loader = route.loader;
export const action = route.action;
