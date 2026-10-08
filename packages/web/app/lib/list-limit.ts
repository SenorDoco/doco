// A long list on a Doco home (pull requests, Slack channels) opens with its
// latest LIST_PAGE rows; each Show more raises its limit by another page,
// held in the URL (`?pr_limit=`, `?slack_channel_limit=`) so the grown list
// stays linkable. Pure and client-safe.

export const LIST_PAGE = 50;

/** A list's limit from its URL param: a whole number above one page, else one page. */
export function parseListLimit(value: string | null): number {
  const limit = Number(value);
  return Number.isInteger(limit) && limit > LIST_PAGE ? limit : LIST_PAGE;
}
