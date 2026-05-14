import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { captureEval, type EvalDraft } from "~/lib/capture.server";

const route = makeCaptureRoute<EvalDraft>({
  type: "evals",
  captureFn: captureEval,
  fillFromAuth: (draft, me) => {
    if (!draft.authored_by_username) draft.authored_by_username = me.username;
  },
});

export const loader = route.loader;
export const action = route.action;
