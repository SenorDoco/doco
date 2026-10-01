// The reader's addresses reach the frame AND what it shows: a codebase's
// or Notion Doco's bare /code or /pages once matched the frame alone (its
// own path outranks the "*" under it), so the home opened with nothing in
// the middle.
import type { RouteConfigEntry } from "@react-router/dev/routes";
import { type RouteObject, matchRoutes } from "react-router";
import { describe, expect, it } from "vitest";
import routes from "../../routes";

function toObjects(entries: RouteConfigEntry[]): RouteObject[] {
  return entries.map((entry) =>
    entry.index
      ? { index: true, id: entry.id ?? entry.file }
      : {
          path: entry.path,
          id: entry.id ?? entry.file,
          children: entry.children ? toObjects(entry.children) : undefined,
        },
  );
}

const files = (url: string) =>
  (matchRoutes(toObjects(routes), url) ?? []).map((match) => match.route.id);

describe("reader routes", () => {
  it.each([
    ["/acme-notion/pages", "routes/$docoHandle.pages.$.tsx"],
    ["/acme-notion/pages/0f2a", "routes/$docoHandle.pages.$.tsx"],
    ["/acme-codebase/code", "routes/$docoHandle.code.$.tsx"],
    ["/acme-codebase/code/acme/app/README.md", "routes/$docoHandle.code.$.tsx"],
  ])("%s opens the reader frame with %s inside it", (url, file) => {
    const matched = files(url);
    expect(matched).toHaveLength(2);
    expect(matched[0]).toMatch(/reader/);
    expect(matched[1]).toBe(file);
  });
});
