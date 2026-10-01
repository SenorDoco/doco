// A codebase or Notion Doco opens in the reader: its home redirects there,
// each reader route serves only its own kind of Doco, and the tree's data
// route lists one folder or page at a time.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  template: "codebase" as string | null,
  listCodeTree: vi.fn(),
  findCodeFiles: vi.fn(),
  loadCodeView: vi.fn(),
  listPageTree: vi.fn(),
  findPages: vi.fn(),
  loadPagesView: vi.fn(),
  loadDocoActivity: vi.fn(),
}));

vi.mock("@doco/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@doco/db")>()),
  withClient: (fn: (c: unknown) => unknown) => fn({}),
}));
vi.mock("~/lib/doco-access.server", () => ({
  loadDocoRouteForRead: async () => ({
    handle: "acme-docs",
    me: null,
    meta: { docoId: "doco_1", template: mocks.template },
  }),
  canAdminDoco: async () => false,
  canWriteDoco: async () => false,
}));
vi.mock("~/lib/codebase-read.server", () => ({
  listCodeTree: mocks.listCodeTree,
  findCodeFiles: mocks.findCodeFiles,
  loadCodeView: mocks.loadCodeView,
}));
vi.mock("~/lib/notion-mirror-read.server", () => ({
  listPageTree: mocks.listPageTree,
  findPages: mocks.findPages,
  loadPagesView: mocks.loadPagesView,
}));
vi.mock("~/lib/doco-activity.server", () => ({
  loadDocoActivity: mocks.loadDocoActivity,
}));

import { loader as docoHome } from "../$docoHandle._index";
import { loader as codeView } from "../$docoHandle.code.$";
import { loader as pagesView } from "../$docoHandle.pages.$";
import { loader as tree } from "../$docoHandle.tree[.]json";

async function thrown(promise: Promise<unknown>): Promise<Response> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("expected a thrown Response");
}

const ACTIVITY = { byDay: { "2026-09-30": 4 }, items: [], topContributors: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.template = "codebase";
  mocks.loadDocoActivity.mockResolvedValue(ACTIVITY);
});

describe("the Doco home of a reader Doco", () => {
  it("redirects a codebase Doco to its code", async () => {
    const res = await thrown(
      docoHome({
        request: new Request("https://doco.test/acme-docs"),
        params: { docoHandle: "acme-docs" },
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/acme-docs/code");
  });

  it("redirects a Notion Doco to its pages, dropping the old perspective state", async () => {
    mocks.template = "notion";
    const res = await thrown(
      docoHome({
        request: new Request("https://doco.test/acme-docs?perspective=notion&notion_page=x"),
        params: { docoHandle: "acme-docs" },
      }),
    );
    expect(res.headers.get("Location")).toBe("/acme-docs/pages");
  });
});

describe("/:docoHandle/code/*", () => {
  it("loads the view the address names, with the search", async () => {
    mocks.loadCodeView.mockResolvedValue({ view: "repos", repos: [], trail: [] });
    const data = await codeView({
      request: new Request("https://doco.test/acme-docs/code/acme/app/src?q=tax"),
      params: { docoHandle: "acme-docs", "*": "acme/app/src" },
    });
    expect(mocks.loadCodeView).toHaveBeenCalledWith({}, "doco_1", {
      id: "acme/app/src",
      query: "tax",
    });
    expect(data).toMatchObject({ handle: "acme-docs", view: { view: "repos" }, activity: null });
    expect(mocks.loadDocoActivity).not.toHaveBeenCalled();
  });

  // Like every other Doco's home, the reader's home shows the Doco's activity.
  it("loads the Doco's activity on its home", async () => {
    mocks.loadCodeView.mockResolvedValue({ view: "repos", repos: [], trail: [] });
    const data = await codeView({
      request: new Request("https://doco.test/acme-docs/code"),
      params: { docoHandle: "acme-docs", "*": "" },
    });
    expect(mocks.loadDocoActivity).toHaveBeenCalledWith({}, "doco_1");
    expect(data).toMatchObject({ activity: ACTIVITY });
  });

  it("is a 404 for a path the copy doesn't have", async () => {
    mocks.loadCodeView.mockResolvedValue(null);
    const res = await thrown(
      codeView({
        request: new Request("https://doco.test/acme-docs/code/acme/app/nope"),
        params: { docoHandle: "acme-docs", "*": "acme/app/nope" },
      }),
    );
    expect(res.status).toBe(404);
  });

  it("is a 404 on a Doco that isn't a codebase", async () => {
    mocks.template = "notion";
    const res = await thrown(
      codeView({
        request: new Request("https://doco.test/acme-docs/code"),
        params: { docoHandle: "acme-docs", "*": "" },
      }),
    );
    expect(res.status).toBe(404);
    expect(mocks.loadCodeView).not.toHaveBeenCalled();
  });
});

describe("/:docoHandle/pages/*", () => {
  beforeEach(() => {
    mocks.template = "notion";
  });

  it("loads the Doco's activity on its home", async () => {
    mocks.loadPagesView.mockResolvedValue({ view: "home", recent: [], top: [], trail: [] });
    const data = await pagesView({
      request: new Request("https://doco.test/acme-docs/pages"),
      params: { docoHandle: "acme-docs", "*": "" },
    });
    expect(mocks.loadDocoActivity).toHaveBeenCalledWith({}, "doco_1");
    expect(data).toMatchObject({ view: { view: "home" }, activity: ACTIVITY });
  });

  it("leaves the activity off an open page", async () => {
    mocks.loadPagesView.mockResolvedValue({ view: "page", page: {}, trail: [] });
    const data = await pagesView({
      request: new Request("https://doco.test/acme-docs/pages/p1"),
      params: { docoHandle: "acme-docs", "*": "p1" },
    });
    expect(mocks.loadDocoActivity).not.toHaveBeenCalled();
    expect(data).toMatchObject({ activity: null });
  });
});

describe("/:docoHandle/tree.json", () => {
  it("lists what is under one item of a codebase", async () => {
    mocks.listCodeTree.mockResolvedValue({ items: [], more: 0 });
    const res = await tree({
      request: new Request("https://doco.test/acme-docs/tree.json?under=acme%2Fapp%2Fsrc"),
      params: { docoHandle: "acme-docs" },
    });
    expect(await res.json()).toEqual({ items: [], more: 0 });
    expect(mocks.listCodeTree).toHaveBeenCalledWith({}, "doco_1", "acme/app/src");
  });

  it("finds pages by title in a Notion Doco", async () => {
    mocks.template = "notion";
    mocks.findPages.mockResolvedValue([]);
    const res = await tree({
      request: new Request("https://doco.test/acme-docs/tree.json?find=onb"),
      params: { docoHandle: "acme-docs" },
    });
    expect(await res.json()).toEqual({ items: [], more: 0 });
    expect(mocks.findPages).toHaveBeenCalledWith({}, "doco_1", "onb", 50);
  });

  it("is a 404 on a Doco without a reader", async () => {
    mocks.template = "decisions";
    const res = await thrown(
      tree({
        request: new Request("https://doco.test/acme-docs/tree.json?under="),
        params: { docoHandle: "acme-docs" },
      }),
    );
    expect(res.status).toBe(404);
  });
});
