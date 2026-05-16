import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { captureState, type StateDraft } from "~/lib/capture.server";

// v7 (decision_01KRRR5BQ16ASY8HQEE0V499YG): POST a State (a node in a
// formal state machine). The State node type is framework-general —
// the state-machines template uses it heavily but any project owner
// can capture States into any scope.

const route = makeCaptureRoute<StateDraft>({
  type: "states",
  captureFn: captureState,
  fillFromAuth: (draft, me) => {
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
    if (!draft.created_by_username) draft.created_by_username = me.username;
  },
});

export const loader = route.loader;
export const action = route.action;
