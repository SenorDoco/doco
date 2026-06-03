export const CREATED_DOCO_ID_SEARCH_PARAM = "created_doco_id";
export const CREATED_DOCO_CHAT_ID_SEARCH_PARAM = "created_chat_id";

const DOCO_ID_PATTERN = /^doco_[0-9A-HJKMNP-TV-Z]{26}$/;
const CHAT_ID_PATTERN = /^conv_[0-9A-HJKMNP-TV-Z]{26}$/;

function withSearchParam(path: string, key: string, value: string): string {
  const [pathAndSearch, hash = ""] = path.split("#", 2);
  const [pathname, rawSearch = ""] = pathAndSearch.split("?", 2);
  const search = new URLSearchParams(rawSearch);
  search.set(key, value);
  const qs = search.toString();
  return `${qs ? `${pathname}?${qs}` : pathname}${hash ? `#${hash}` : ""}`;
}

export function readCreatedDocoIdSearchParam(request: Request): string | null {
  const id = new URL(request.url).searchParams.get(CREATED_DOCO_ID_SEARCH_PARAM);
  if (!id || !DOCO_ID_PATTERN.test(id)) return null;
  return id;
}

export function readCreatedDocoChatIdSearchParams(search: URLSearchParams): string | null {
  const id = search.get(CREATED_DOCO_CHAT_ID_SEARCH_PARAM);
  if (!id || !CHAT_ID_PATTERN.test(id)) return null;
  return id;
}

export function withCreatedDocoId(path: string, docoId: string): string {
  return withSearchParam(path, CREATED_DOCO_ID_SEARCH_PARAM, docoId);
}
