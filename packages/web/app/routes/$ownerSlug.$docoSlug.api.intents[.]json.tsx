import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { captureIntent, type IntentDraft } from "~/lib/capture.server";

const route = makeCaptureRoute<IntentDraft>({
  type: "intents",
  captureFn: captureIntent,
  fillFromAuth: (draft, me) => {
    if (!draft.wanted_by_username) draft.wanted_by_username = me.username;
  },
});

export const loader = route.loader;
export const action = route.action;
