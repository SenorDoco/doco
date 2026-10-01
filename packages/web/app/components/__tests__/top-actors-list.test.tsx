import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TopActor } from "~/lib/top-actors.server";
import { TopActorsList } from "../top-actors-list";

const now = new Date().toISOString();

function render(actors: TopActor[]): string {
  return renderToStaticMarkup(
    createElement(TopActorsList, { actors, empty: "No recorded queries yet." }),
  ).replace(/<!-- -->/g, "");
}

describe("TopActorsList", () => {
  it("names the agent each person worked through and marks the website", () => {
    const html = render([
      { userId: "user_alice", username: "alice", via: "Claude Code", count: 1336, lastAt: now },
      { userId: "user_alice", username: "alice", via: null, count: 12, lastAt: now },
    ]);
    expect(html).toContain("alice");
    expect(html).toContain("via Claude Code");
    expect(html).toContain("on the website");
    expect(html).toContain("1,336");
  });

  it("says when nothing is recorded", () => {
    expect(render([])).toContain("No recorded queries yet.");
  });
});
