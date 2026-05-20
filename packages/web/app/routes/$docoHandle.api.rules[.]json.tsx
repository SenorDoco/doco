import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { captureRule, type RuleDraft } from "~/lib/capture.server";

const route = makeCaptureRoute<RuleDraft>({
  type: "rules",
  captureFn: captureRule,
  fillFromAuth: (draft, me) => {
    if (!draft.authored_by_username) draft.authored_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  },
});

export const loader = route.loader;
export const action = route.action;
