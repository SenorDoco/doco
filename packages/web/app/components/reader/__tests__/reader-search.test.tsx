// @vitest-environment happy-dom
//
// The reader's one search box: as you type it lists the files (or pages)
// whose names match, and picking one opens it; Enter on the first row
// searches inside them instead.
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { createRoutesStub, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReaderListing } from "~/lib/reader";
import { ReaderSearch } from "../reader-search";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const found: ReaderListing = {
  items: [
    {
      id: "acme/app/src/billing/tax.ts",
      name: "tax.ts",
      kind: "file",
      icon: null,
      hasChildren: false,
      files: null,
      pending: false,
      where: "acme/app/src/billing",
    },
  ],
  more: 0,
};

let fetchMock: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: Root;

function Where() {
  const location = useLocation();
  return <output data-testid="where">{`${location.pathname}${location.search}`}</output>;
}

async function mount(reader: "code" | "pages", handle: string, url: string) {
  const Stub = createRoutesStub([
    {
      path: "*",
      Component: () => (
        <>
          <ReaderSearch handle={handle} reader={reader} query="" />
          <Where />
        </>
      ),
    },
  ]);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Stub initialEntries={[url]} />));
}

const input = () => container.querySelector("input") as HTMLInputElement;
const where = () => container.querySelector('[data-testid="where"]')?.textContent;
const options = () => [...container.querySelectorAll("ul a")].map((row) => row.textContent);

async function type(text: string) {
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setValue?.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
  // The name lookup waits for typing to pause.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
}

async function press(key: string) {
  await act(async () => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify(found)));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("ReaderSearch", () => {
  it("lists the files whose names match as you type, under a row that searches inside them", async () => {
    await mount("code", "acme-codebase", "/acme-codebase/code/acme/app/README.md");
    expect(input().placeholder).toBe("Find a file or search the code");
    await type("tax");
    expect(fetchMock).toHaveBeenCalledWith("/acme-codebase/tree.json?find=tax", expect.anything());
    expect(options()).toEqual(["Search the code for “tax”", "tax.tsacme/app/src/billing"]);
    expect(input().getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the file picked", async () => {
    await mount("code", "acme-codebase", "/acme-codebase/code");
    await type("tax");
    await press("ArrowDown");
    await press("Enter");
    expect(where()).toBe("/acme-codebase/code/acme/app/src/billing/tax.ts");
    expect(options()).toEqual([]);
  });

  it("searches inside the files on Enter, from where the reader is", async () => {
    await mount("code", "acme-codebase", "/acme-codebase/code/acme/app/README.md");
    await type("tax rate");
    await press("Enter");
    expect(where()).toBe("/acme-codebase/code/acme/app/README.md?q=tax+rate");
  });

  it("closes the list on Escape", async () => {
    await mount("code", "acme-codebase", "/acme-codebase/code");
    await type("tax");
    await press("Escape");
    expect(options()).toEqual([]);
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });

  it("finds pages by title in a Notion Doco", async () => {
    await mount("pages", "acme-notion", "/acme-notion/pages");
    expect(input().placeholder).toBe("Find a page or search every page");
    await type("onb");
    expect(options()[0]).toBe("Search every page for “onb”");
  });
});
