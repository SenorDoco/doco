import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { captureReference, type ReferenceDraft } from "~/lib/capture.server";

const route = makeCaptureRoute<ReferenceDraft>({
  type: "references",
  captureFn: captureReference,
  fillFromAuth: (draft, me) => {
    if (!draft.created_by_username) draft.created_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  },
});

export const loader = route.loader;
export const action = route.action;
