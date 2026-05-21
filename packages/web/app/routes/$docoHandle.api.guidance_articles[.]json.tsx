import { makeCaptureRoute } from "~/lib/api-capture-factory.server";
import { type GuidanceArticleDraft, captureGuidanceArticle } from "~/lib/capture.server";

const route = makeCaptureRoute<GuidanceArticleDraft>({
  type: "guidance_articles",
  captureFn: captureGuidanceArticle,
  fillFromAuth: (draft, me) => {
    if (!draft.authored_by_username) draft.authored_by_username = me.username;
    if (!draft.created_by_id && me.id) draft.created_by_id = me.id;
  },
});

export const loader = route.loader;
export const action = route.action;
