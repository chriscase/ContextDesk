/**
 * parseBlocks completeness (#156): ordered lists, blockquotes, fences.
 */
import { describe, expect, it } from "vitest";
import { __mdTest } from "./MarkdownBody";

const { parseBlocks } = __mdTest;

describe("parseBlocks markdown completeness (#156)", () => {
  it("parses ordered lists as ol blocks", () => {
    const blocks = parseBlocks("1. first\n2. second\n3) third");
    expect(blocks).toEqual([
      { kind: "ol", items: ["first", "second", "third"] },
    ]);
  });

  it("parses blockquotes joining consecutive > lines", () => {
    const blocks = parseBlocks("> line one\n> line two\n\npara");
    expect(blocks[0]).toEqual({
      kind: "blockquote",
      text: "line one\nline two",
    });
    expect(blocks[1]).toEqual({ kind: "p", text: "para" });
  });

  it("parses fenced code with lang and open fence", () => {
    const closed = parseBlocks("```ts\nconst x = 1;\n```");
    expect(closed[0]).toMatchObject({
      kind: "pre",
      lang: "ts",
      text: "const x = 1;",
      open: false,
    });
    const open = parseBlocks("```rust\nfn main() {");
    expect(open[0]).toMatchObject({
      kind: "pre",
      lang: "rust",
      open: true,
    });
  });

  it("still parses ul / headings / does not inject raw HTML", () => {
    const blocks = parseBlocks("- a\n- b\n\n## Head\n\n<script>x</script>");
    expect(blocks.some((b) => b.kind === "ul")).toBe(true);
    expect(blocks.some((b) => b.kind === "h")).toBe(true);
    const p = blocks.find((b) => b.kind === "p" && "text" in b);
    expect(p && p.kind === "p" ? p.text : "").toContain("<script>");
  });
});
