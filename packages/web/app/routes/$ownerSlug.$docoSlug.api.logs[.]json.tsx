import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { captureLog, type LogDraft } from "~/lib/capture.server";

const route = makeCaptureRoute<LogDraft>({
  type: "logs",
  captureFn: captureLog,
  fillFromAuth: (draft, me) => {
    if (!draft.performed_by_username) draft.performed_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  },
});

export const loader = route.loader;
export const action = route.action;
