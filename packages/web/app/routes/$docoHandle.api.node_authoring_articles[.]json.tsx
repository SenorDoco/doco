import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { type NodeAuthoringArticleDraft, captureNodeAuthoringArticle } from "~/lib/capture.server";

const route = makeCaptureRoute<NodeAuthoringArticleDraft>({
  type: "node_authoring_articles",
  captureFn: captureNodeAuthoringArticle,
  fillFromAuth: (draft, me) => {
    if (!draft.authored_by_username) draft.authored_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  },
});

export const loader = route.loader;
export const action = route.action;
