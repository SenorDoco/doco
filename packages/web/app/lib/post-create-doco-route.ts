export const CREATED_DOCO_ID_SEARCH_PARAM = "created_doco_id";

const DOCO_ID_PATTERN = /^doco_[0-9A-HJKMNP-TV-Z]{26}$/;

export function readCreatedDocoIdSearchParam(request: Request): string | null {
  const id = new URL(request.url).searchParams.get(CREATED_DOCO_ID_SEARCH_PARAM);
  if (!id || !DOCO_ID_PATTERN.test(id)) return null;
  return id;
}

export function withCreatedDocoId(path: string, docoId: string): string {
  const [pathname, rawSearch = ""] = path.split("?", 2);
  const search = new URLSearchParams(rawSearch);
  search.set(CREATED_DOCO_ID_SEARCH_PARAM, docoId);
  const qs = search.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
