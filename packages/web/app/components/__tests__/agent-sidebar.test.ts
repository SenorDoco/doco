import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import {
  COMPOSER_ECHO_GUARD_MS,
  Composer,
  DocoChatRef,
  SenorDocoExplainer,
  applyComposerEchoGuard,
  chatBubbleBlocks,
  docoHandleFromPath,
  formatThreadUsageLabel,
  mergeCreatedConversationListItem,
  planSend,
  renderInlineLinks,
} from "../agent-sidebar";

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: "conv_old",
    title: "Existing thread",
    archived: false,
    message_count: 1,
    updated_at: "2026-06-01T00:00:00.000Z",
    active_turn_started_at: null,
    last_message_preview: "Hello",
    last_message_role: "user" as const,
    workspace_id: null,
    workspace_handle: null,
    doco_id: null,
    doco_handle: null,
    doco_owner_slug: null,
    ...overrides,
  };
}

describe("mergeCreatedConversationListItem", () => {
  it("puts a newly-created thread at the top of the thread list", () => {
    const existing = conversation();
    const created = conversation({
      id: "conv_new",
      title: null,
      message_count: 0,
      last_message_preview: null,
      last_message_role: null,
      updated_at: "2026-06-01T00:01:00.000Z",
    });

    expect(mergeCreatedConversationListItem([existing], created)).toEqual([created, existing]);
  });

  it("replaces a duplicate created thread instead of showing it twice", () => {
    const staleCreated = conversation({
      id: "conv_new",
      title: "Old title",
    });
    const created = conversation({
      id: "conv_new",
      title: null,
      message_count: 0,
      last_message_preview: null,
      last_message_role: null,
    });

    expect(mergeCreatedConversationListItem([staleCreated], created)).toEqual([created]);
  });
});

describe("docoHandleFromPath", () => {
  it("reads the Doco handle off a Doco page so its chat can auto-open", () => {
    expect(docoHandleFromPath("/billing")).toBe("billing");
    expect(docoHandleFromPath("/billing/decision/decision_01ABC")).toBe("billing");
    expect(docoHandleFromPath("/acme-ops/perspectives")).toBe("acme-ops");
  });

  it("returns null on reserved top-level routes (not Docos)", () => {
    expect(docoHandleFromPath("/dashboard")).toBeNull();
    expect(docoHandleFromPath("/workspaces/acme")).toBeNull();
    expect(docoHandleFromPath("/new-doco")).toBeNull();
    expect(docoHandleFromPath("/sign-in")).toBeNull();
    expect(docoHandleFromPath("/api/v1/whoami.json")).toBeNull();
  });

  it("returns null on host routes that post-date the shared reserved set", () => {
    expect(docoHandleFromPath("/tokens")).toBeNull();
    expect(docoHandleFromPath("/integrations/slack/setup")).toBeNull();
    expect(docoHandleFromPath("/users/alice")).toBeNull();
    expect(docoHandleFromPath("/api-keys")).toBeNull();
  });

  it("returns null at the root / empty path", () => {
    expect(docoHandleFromPath("/")).toBeNull();
    expect(docoHandleFromPath("")).toBeNull();
  });
});

describe("DocoChatRef", () => {
  function html(props: { workspaceHandle?: string | null; docoHandle: string; asLink?: boolean }) {
    return renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(DocoChatRef, props)),
    );
  }

  it("renders the non-editable 'workspace / doco' reference", () => {
    const out = html({ workspaceHandle: "acme", docoHandle: "billing" });
    expect(out).toContain("acme");
    expect(out).toContain("billing");
    expect(out).toContain("acme / billing");
  });

  it("renders plain text (no links) by default — the inbox row handles clicks", () => {
    const out = html({ workspaceHandle: "acme", docoHandle: "billing" });
    expect(out).not.toContain("<a ");
  });

  it("links each segment to its page when asLink (the chat header)", () => {
    const out = html({ workspaceHandle: "acme", docoHandle: "billing", asLink: true });
    const anchors = out.match(/<a [^>]*>/g) ?? [];
    expect(anchors.join(" ")).toContain('href="/workspaces/acme"');
    expect(anchors.join(" ")).toContain('href="/billing"');
  });

  it("falls back to just the Doco when there's no workspace", () => {
    const out = html({ workspaceHandle: null, docoHandle: "billing" });
    expect(out).toContain("billing");
    expect(out).not.toContain(" / ");
  });
});

describe("SenorDocoExplainer", () => {
  function markup() {
    return renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(SenorDocoExplainer)),
    );
  }

  it("says Señor Doco uses Sonnet and only handles simple requests", () => {
    expect(markup()).toContain("Señor Doco uses Sonnet and can only handle simple requests");
  });

  it("invites collaboration via the MCP, linking the tokens page", () => {
    const html = markup();
    expect(html).toContain("Want to collaborate with your own agent?");
    const anchor = html.match(/<a [^>]*>Connect the MCP<\/a>/)?.[0] ?? "";
    expect(anchor).toContain('href="/tokens"');
  });

  it("separates from the header with a neumorphic-eligible divider, not a hard line", () => {
    // app.css auto-rewrites `border-b border-border` into a soft etched
    // highlight, but its `[class~="border-border"]` selector only matches the
    // exact token — an opacity modifier like `border-border/70` slips past and
    // renders as a raw 1px stroke, which is off-style for the neumorphic rail.
    const className = markup().match(/<div class="([^"]*border-b[^"]*)"/)?.[1] ?? "";
    expect(className).toContain("border-b");
    expect(className).toContain("border-border");
    expect(className).not.toMatch(/border-border\//);
  });
});

describe("chatBubbleBlocks", () => {
  it("softens a tool-call preamble's dangling colon to an ellipsis", () => {
    expect(
      chatBubbleBlocks([
        { type: "text", text: "Let me update both fields with proper enumeration:" },
        { type: "tool_use", id: "t1", name: "doco_api", input: {} },
      ]),
    ).toEqual([{ type: "text", text: "Let me update both fields with proper enumeration…" }]);
  });

  it("drops tool_use and tool_result blocks", () => {
    expect(
      chatBubbleBlocks([
        { type: "text", text: "Done." },
        { type: "tool_use", id: "t1", name: "doco_api", input: {} },
        { type: "tool_result", tool_use_id: "t1", content: "{}" },
      ]),
    ).toEqual([{ type: "text", text: "Done." }]);
  });

  it("keeps a genuine trailing colon when no tool call follows it", () => {
    expect(chatBubbleBlocks([{ type: "text", text: "Here are the options:" }])).toEqual([
      { type: "text", text: "Here are the options:" },
    ]);
  });

  it("leaves a preamble without a trailing colon unchanged", () => {
    expect(
      chatBubbleBlocks([
        { type: "text", text: "Checking the graph." },
        { type: "tool_use", id: "t1", name: "doco_api", input: {} },
      ]),
    ).toEqual([{ type: "text", text: "Checking the graph." }]);
  });
});

describe("renderInlineLinks", () => {
  function html(text: string) {
    return renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement("div", null, renderInlineLinks(text))),
    );
  }

  it("renders a markdown footer link as a clickable anchor", () => {
    const out = html(
      "[🔮 Doco] ✍️ Decision added: [Use checked footers](https://doco.test/acme-ops/decision/decision_01ABC)",
    );
    expect(out).toContain("Use checked footers");
    expect(out).toContain("decision/decision_01ABC");
    expect(out).toContain("<a");
  });

  it("strikes through a retired entity's link instead of leaking ~~ markers", () => {
    // capture.server.ts wraps the entity anchor in ~~...~~ when the
    // lifecycle is set to a struck value (e.g. "retired"); the chat must
    // render that as strikethrough, not show literal tildes around the link.
    const out = html(
      '[🔮 Doco] 📝 State updated: ~~[state_01KT7MSSP4DJ1G6GCP7CCRZECJ](https://doco.test/acme-ops/state/state_01KT7MSSP4DJ1G6GCP7CCRZECJ)~~.lifecycle set to "retired"',
    );
    // the link survives and is still clickable
    expect(out).toContain("state_01KT7MSSP4DJ1G6GCP7CCRZECJ");
    expect(out).toContain("state/state_01KT7MSSP4DJ1G6GCP7CCRZECJ");
    // it is struck through (retired), matching the activity-feed convention
    expect(out).toContain("line-through");
    // and the raw markdown markers never reach the user
    expect(out).not.toContain("~~");
  });

  it("strikes through plain (un-linked) retired text without leaking markers", () => {
    const out = html('[🔮 Doco] 📝 State updated: ~~state_01ABC~~.lifecycle set to "retired"');
    expect(out).toContain("state_01ABC");
    expect(out).toContain("line-through");
    expect(out).not.toContain("~~");
  });

  it("leaves an ordinary footer line free of strikethrough", () => {
    const out = html(
      '[🔮 Doco] 📝 State updated: [my state](https://doco.test/acme-ops/state/state_01ABC).lifecycle set to "active"',
    );
    expect(out).toContain("my state");
    expect(out).not.toContain("line-through");
    expect(out).not.toContain("~~");
  });
});

describe("applyComposerEchoGuard", () => {
  const guard = (text: string, at: number) => ({ text, at });

  it("drops the post-send echo that would refill a just-cleared composer", () => {
    // send() clears the box and arms the guard with what it cleared; macOS
    // autocorrect / IME then fires a trailing change carrying that same text a
    // few ms later. That echo is the reported bug — it must be swallowed, not
    // applied, so the textarea stays empty after Send.
    expect(applyComposerEchoGuard("Ship it", guard("Ship it", 1000), 1010)).toEqual({
      value: "",
      guard: null,
    });
  });

  it("still guards at the exact window boundary", () => {
    expect(
      applyComposerEchoGuard("Ship it", guard("Ship it", 1000), 1000 + COMPOSER_ECHO_GUARD_MS),
    ).toEqual({ value: "", guard: null });
  });

  it("passes a genuine edit through and spends the guard", () => {
    // The first change after a send that ISN'T the echo is a real edit — apply
    // it verbatim and disarm, so the guard never lingers to eat later input.
    expect(applyComposerEchoGuard("Ship", guard("Ship it", 1000), 1010)).toEqual({
      value: "Ship",
      guard: null,
    });
  });

  it("does not swallow the same text re-typed after the guard window", () => {
    // A real echo lands within milliseconds; the same text arriving much later
    // is the user deliberately re-typing it, and must go through.
    expect(
      applyComposerEchoGuard("Ship it", guard("Ship it", 1000), 1000 + COMPOSER_ECHO_GUARD_MS + 1),
    ).toEqual({ value: "Ship it", guard: null });
  });

  it("passes input through untouched when no guard is armed", () => {
    expect(applyComposerEchoGuard("typing…", null, 5000)).toEqual({
      value: "typing…",
      guard: null,
    });
  });
});

describe("Composer", () => {
  function markup(props: Record<string, unknown> = {}) {
    return renderToStaticMarkup(
      createElement(Composer, {
        value: "",
        onChange: () => {},
        onSend: () => {},
        onStop: () => {},
        username: "alice",
        staged: [],
        queuedCount: 0,
        uploading: false,
        uploadError: null,
        onUploadFiles: () => {},
        onRemoveStaged: () => {},
        busy: false,
        ...props,
      } as never),
    );
  }

  it("offers a Stop button beside Send while Señor Doco is replying", () => {
    const out = markup({ busy: true });
    expect(out).toContain('aria-label="Stop Señor Doco"');
    expect(out).toContain(">Stop<");
    // Send stays — a message typed mid-reply still queues behind the turn.
    expect(out).toContain(">Send<");
  });

  it("hides Stop when idle — there is nothing to interrupt", () => {
    const out = markup({ busy: false });
    expect(out).not.toContain('aria-label="Stop Señor Doco"');
    expect(out).not.toContain(">Stop<");
    expect(out).toContain(">Send<");
  });
});

describe("planSend", () => {
  const ctx = (
    o: Partial<{ busy: boolean; remoteInflight: boolean; isOverride: boolean }> = {},
  ) => ({ busy: false, remoteInflight: false, isOverride: false, ...o });

  it("ignores a send with no text and no attachments", () => {
    expect(planSend(false, ctx())).toBe("ignore");
    expect(planSend(false, ctx({ busy: true }))).toBe("ignore");
  });

  it("sends immediately when Señor Doco is idle", () => {
    expect(planSend(true, ctx())).toBe("send");
  });

  it("queues a message sent while Señor Doco is mid-reply", () => {
    // The whole point of the queue: don't abort the in-flight turn to race a
    // second one against the API's user→assistant→user alternation — park it
    // and let the drain fire it once the turn settles.
    expect(planSend(true, ctx({ busy: true }))).toBe("queue");
  });

  it("queues when another tab is mid-reply", () => {
    expect(planSend(true, ctx({ remoteInflight: true }))).toBe("queue");
  });

  it("lets a queue drain (override) bypass the queue and send", () => {
    // The drain replays a queued message with an override; it must send even
    // if something still reads as busy mid-transition.
    expect(planSend(true, ctx({ busy: true, isOverride: true }))).toBe("send");
  });
});

describe("formatThreadUsageLabel", () => {
  it("reads turns · headline tokens (input+output) · estimated cost", () => {
    expect(
      formatThreadUsageLabel({
        input_tokens: 500,
        output_tokens: 500,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turn_count: 1,
        estimated_cost_usd: 0.0042,
      }),
    ).toBe("1 turn · 1.0k tokens · ~$0.0042");
  });

  it("pluralizes turns and rounds large token counts", () => {
    expect(
      formatThreadUsageLabel({
        input_tokens: 120_000,
        output_tokens: 30_000,
        cache_read_tokens: 4_000_000,
        cache_creation_tokens: 0,
        turn_count: 3,
        estimated_cost_usd: 0.51,
      }),
    ).toBe("3 turns · 150k tokens · ~$0.5100");
  });

  it("shows two decimals for costs of a dollar or more", () => {
    expect(
      formatThreadUsageLabel({
        input_tokens: 800_000,
        output_tokens: 40_000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turn_count: 9,
        estimated_cost_usd: 2.5,
      }),
    ).toBe("9 turns · 840k tokens · ~$2.50");
  });

  it("reads cleanly for a brand-new thread with no turns", () => {
    expect(
      formatThreadUsageLabel({
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        turn_count: 0,
        estimated_cost_usd: 0,
      }),
    ).toBe("0 turns · 0 tokens · ~$0.00");
  });
});
