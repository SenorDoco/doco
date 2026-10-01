import { describe, expect, it } from "vitest";
import { highlightLines } from "../code-highlight.server";

describe("highlightLines", () => {
  it("colors code by token, one array per line", () => {
    expect(highlightLines("src/a.ts", 'const a = "x";\n// done')).toEqual([
      [["k", "const"], " a = ", ["s", '"x"'], ";"],
      [["c", "// done"]],
    ]);
  });

  it("names functions and numbers", () => {
    expect(highlightLines("a.js", "function f() { return 1; }")).toEqual([
      [["k", "function"], " ", ["f", "f"], "() { ", ["k", "return"], " ", ["n", "1"], "; }"],
    ]);
  });

  it("carries a token that spans lines onto each line it covers", () => {
    expect(highlightLines("a.ts", "/* one\ntwo */ x")).toEqual([
      [["c", "/* one"]],
      [["c", "two */"], " x"],
    ]);
  });

  it("knows a language by its file name when the name is all there is", () => {
    expect(highlightLines("Makefile", "all:\n\techo hi")[0]).not.toEqual(["all:"]);
  });

  it("leaves a file in a language it doesn't know as plain lines", () => {
    expect(highlightLines("LICENSE", "MIT\n\nCopyright")).toEqual([["MIT"], [], ["Copyright"]]);
  });

  it("leaves a very large file as plain lines", () => {
    const lines = highlightLines("big.ts", "const a = 1;\n".repeat(10_000));
    expect(lines[0]).toEqual(["const a = 1;"]);
    expect(lines).toHaveLength(10_000);
  });

  it("counts lines as an editor does: no line after the final newline, none in an empty file", () => {
    expect(highlightLines("notes.txt", "one\ntwo\n")).toEqual([["one"], ["two"]]);
    expect(highlightLines("empty.ts", "")).toEqual([]);
  });
});
