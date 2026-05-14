import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { captureReasoning, type ReasoningDraft } from "~/lib/capture.server";

const route = makeCaptureRoute<ReasoningDraft>({
  type: "reasoning",
  captureFn: captureReasoning,
  fillFromAuth: (draft, me) => {
    if (!draft.authored_by_username) draft.authored_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  },
});

export const loader = route.loader;
export const action = route.action;
