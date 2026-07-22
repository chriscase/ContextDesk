/**
 * parseBlocks completeness (#156): ordered lists, blockquotes, fences.
 * Lists + table cells: unicode bullets, no double markers / raw <br> text.
 */
import { describe, expect, it } from "vitest";
import { __mdTest } from "./MarkdownBody";

const { parseBlocks, renderInline, looksLikeListBlob, stripListMarker } =
  __mdTest;

describe("parseBlocks markdown completeness (#156)", () => {
  it("parses ordered lists as ol blocks", () => {
    const blocks = parseBlocks("1. first\n2. second\n3) third");
    expect(blocks).toEqual([
      { kind: "ol", items: ["first", "second", "third"] },
    ]);
  });

  it("parses unicode bullet lists as ul", () => {
    const blocks = parseBlocks("• alpha\n• beta\n- gamma");
    expect(blocks[0]).toEqual({
      kind: "ul",
      items: ["alpha", "beta", "gamma"],
    });
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

describe("renderInline lists and breaks", () => {
  it("turns model <br> into real breaks, not visible tags", () => {
    const html = renderInline("Line one<br>Line two<br/>Line three");
    expect(html).toContain("Line one<br />Line two<br />Line three");
    expect(html).not.toContain("&lt;br");
  });

  it("does not convert plain newlines into br (pre-wrap handles them)", () => {
    const html = renderInline("Line one\nLine two");
    // default ctx: no auto br; newlines remain or are list-handled
    expect(html).not.toContain("<br />");
    expect(html).toContain("Line one");
    expect(html).toContain("Line two");
  });

  it("keeps dangerous tags escaped", () => {
    const html = renderInline(
      "ok <script>alert(1)</script> <img src=x onerror=1>",
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toMatch(/<script>/i);
    expect(html).not.toMatch(/<img/i);
  });

  it("strips list markers for list-item context", () => {
    const html = renderInline("• already bulleted", "list-item");
    expect(html).toBe("already bulleted");
    expect(html).not.toContain("•");
  });

  it("converts bullet blobs in table cells into nested lists", () => {
    expect(looksLikeListBlob("• Alpha<br>• Beta<br>• Gamma")).toBe(true);
    const html = renderInline("• Alpha<br>• Beta<br>• Gamma", "table-cell");
    expect(html).toContain('class="md-inline-list"');
    expect(html).toContain("<li>Alpha</li>");
    expect(html).toContain("<li>Beta</li>");
    // No leftover bullet glyphs inside the li text
    expect(html).not.toMatch(/<li>•/);
    expect(html).not.toContain("&lt;br");
  });

  it("stripListMarker handles dash and unicode", () => {
    expect(stripListMarker("- hello")).toBe("hello");
    expect(stripListMarker("• hello")).toBe("hello");
    expect(stripListMarker("1. hello")).toBe("hello");
  });
});
