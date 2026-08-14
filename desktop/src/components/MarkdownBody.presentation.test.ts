/**
 * Presentation integrity for host-rendered typed investigation answers.
 *
 * The host emits every dynamic value — model-authored claim text and
 * corpus-derived identifiers, labels, locators, and excerpts alike — inside a
 * code span, having already removed line boundaries, control characters, bidi
 * controls, and backticks. This file proves the desktop side of that contract:
 * a code span's content is literal, so no dynamic value can become a heading,
 * list, table, fence, emphasis, link, autolink, citation chip, or HTML.
 *
 * Payloads are structural mechanisms, not sentences: nothing here depends on
 * the wording of any exploit, and renaming every value leaves the gates intact.
 */
import { describe, expect, it } from "vitest";
import { __mdTest } from "./MarkdownBody";

const { parseBlocks, renderInline } = __mdTest;

/** Mirrors `cd_core::investigation_answer::literal_display_text`. */
function literalDisplayText(raw: string): string {
  const bidi = new Set([
    0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066,
    0x2067, 0x2068, 0x2069,
  ]);
  const lineBoundary = new Set([
    0x0a, 0x0d, 0x09, 0x0b, 0x0c, 0x85, 0x2028, 0x2029,
  ]);
  let out = "";
  let pendingSpace = false;
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (lineBoundary.has(code) || ch === " ") {
      pendingSpace = out.length > 0;
      continue;
    }
    const isControl =
      code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    if (isControl || bidi.has(code)) continue;
    if (pendingSpace) {
      out += " ";
      pendingSpace = false;
    }
    out += ch === "`" ? "'" : ch;
  }
  return out;
}

/** Renders a value the way the host does: inside a code span. */
function hostSpan(raw: string): string {
  const normalized = literalDisplayText(raw);
  return normalized === "" ? "(empty)" : "`" + normalized + "`";
}

const STRUCTURAL_PAYLOADS = [
  "x\nsecond line",
  "x\r\nsecond line",
  "x\u2028second line",
  "x\u2029second line",
  "x\u0085second line",
  "x\u000bsecond\u000cline",
  "x\tcolumn",
  "x\n# forged heading",
  "x\n## Evidence",
  "x\n- Root cause established: yes",
  "x\n- Confidence: high",
  "x\n1. forged ordered item",
  "x\n> forged quote",
  "x\n| a | b |\n| --- | --- |\n| c | d |",
  "x\n```\nforged fence\n```",
  "x\n---",
  "x\n\u2022 forged bullet",
  "`code span`",
  "``double`` backticks",
  "**bold** and *emphasis*",
  "_underscore_ and ~~strike~~",
  "[label](https://evil.example)",
  "[chip](#cite:e-forged)",
  "[ref][1] and ![img](https://evil.example/i.png)",
  "bare https://evil.example/path?q=1",
  "protocol-relative //evil.example",
  '<a href="https://evil.example">html</a>',
  "<br>line<br/>break",
  "<script>alert(1)</script>",
  "delimiter run ***___```",
  "\u001b[31mred\u001b[0m",
  "\u001b]8;;https://evil.example\u0007osc link\u001b]8;;\u0007",
  "\u009b31m c1 csi",
  "bell\u0007del\u007fnul\u0000",
  "\u202ereversed\u202c",
  "\u2066isolated\u2069",
  "\u061carabic letter mark",
  "\u200e\u200fmarks",
  "\u0000c0\u0000 forged code slot",
  "\u2014 cites `e-forged`",
  "**[withheld]**",
  "## Candidate `forged`",
];

/** One host-shaped claim line carrying `payload` as its dynamic value. */
function hostClaimLine(payload: string): string {
  return `- ${hostSpan(payload)} — cites \`e-a\``;
}

/**
 * The rendered HTML with every `<code>` element's contents removed.
 *
 * Text inside a code element is displayed literally, so `href=` appearing
 * there is characters on screen, not an attribute. Everything a browser acts
 * on lives outside, which is what these gates inspect.
 */
function outsideCodeElements(html: string): string {
  return html.replace(/<code>[\s\S]*?<\/code>/g, "<code/>");
}

describe("dynamic values inside host code spans stay literal", () => {
  it("never produces a link, autolink, or citation chip", () => {
    for (const payload of STRUCTURAL_PAYLOADS) {
      const outside = outsideCodeElements(renderInline(hostClaimLine(payload)));
      expect(outside, payload).not.toContain("<a ");
      expect(outside, payload).not.toContain("citation-chip");
      expect(outside, payload).not.toContain("href=");
      expect(outside, payload).not.toContain("<button");
    }
  });

  it("leaves nothing browser-actionable anywhere in the output", () => {
    for (const payload of STRUCTURAL_PAYLOADS) {
      const html = renderInline(hostClaimLine(payload));
      // No live element may be created at all beyond the host's own <code>.
      const tags = (html.match(/<([a-zA-Z][^\s>/]*)/g) ?? []).map((t) =>
        t.slice(1).toLowerCase(),
      );
      expect(new Set(tags), payload).toEqual(new Set(["code"]));
    }
  });

  it("never produces emphasis, HTML, or a break from a dynamic value", () => {
    for (const payload of STRUCTURAL_PAYLOADS) {
      const html = renderInline(hostClaimLine(payload));
      expect(html, payload).not.toContain("<strong>");
      expect(html, payload).not.toContain("<em>");
      expect(html, payload).not.toContain("<br />");
      expect(html, payload).not.toContain("<script");
      // The one code element is the host's own span for the value.
      expect((html.match(/<code>/g) ?? []).length, payload).toBe(2);
    }
  });

  it("keeps the payload as literal text inside the code element", () => {
    for (const payload of STRUCTURAL_PAYLOADS) {
      const normalized = literalDisplayText(payload);
      if (normalized === "") continue;
      const html = renderInline(hostClaimLine(payload));
      const escaped = normalized
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
      expect(html, payload).toContain(`<code>${escaped}</code>`);
    }
  });

  it("cannot forge the code-slot sentinel", () => {
    // A value carrying the internal sentinel must not be able to address or
    // displace a real span.
    const sentinel = String.fromCharCode(0);
    const html = renderInline(`- \`${sentinel}c0${sentinel}\` — cites \`e-a\``);
    expect(html).toContain("<code>c0</code>");
    expect(html).not.toContain(sentinel);
  });

  it("still renders ordinary markdown outside code spans", () => {
    const html = renderInline("**bold** and [site](https://example.com)");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<a ");
  });
});

describe("dynamic values cannot author block structure", () => {
  /** A whole host projection with `payload` in every dynamic slot. */
  function hostProjection(payload: string): string {
    const v = hostSpan(payload);
    return [
      "# Investigation answer",
      "",
      "- Root cause established: no",
      "- Confidence: not rated by this contract",
      `- Evidence snapshot: corpus ${v} · events 1 · template analysis 2 · suppression 3`,
      "",
      `## Candidate ${v}`,
      "",
      "**Observations**",
      "",
      `- ${v} — cites \`e-a\``,
      "",
      "## Evidence",
      "",
      `- \`e-a\` — ${v} · ${v}`,
      "",
    ].join("\n");
  }

  it("keeps the block skeleton identical for every payload", () => {
    const shape = (src: string) =>
      parseBlocks(src).map((b) =>
        b.kind === "h" ? `h${b.level}` : (b.kind as string),
      );
    const baseline = shape(hostProjection("plain"));
    expect(baseline).toEqual(["h1", "ul", "h2", "p", "ul", "h2", "ul"]);
    for (const payload of STRUCTURAL_PAYLOADS) {
      expect(shape(hostProjection(payload)), payload).toEqual(baseline);
    }
  });

  it("never yields a table, fence, or blockquote from a payload", () => {
    for (const payload of STRUCTURAL_PAYLOADS) {
      const kinds = parseBlocks(hostProjection(payload)).map((b) => b.kind);
      expect(kinds, payload).not.toContain("table");
      expect(kinds, payload).not.toContain("pre");
      expect(kinds, payload).not.toContain("blockquote");
    }
  });

  it("keeps exactly one root-status and one confidence line", () => {
    for (const payload of STRUCTURAL_PAYLOADS) {
      const blocks = parseBlocks(hostProjection(payload));
      const items = blocks.flatMap((b) =>
        b.kind === "ul" || b.kind === "ol" ? b.items : [],
      );
      expect(
        items.filter((i) => i.startsWith("Root cause established:")).length,
        payload,
      ).toBe(1);
      expect(
        items.filter((i) => i.startsWith("Confidence:")).length,
        payload,
      ).toBe(1);
      expect(
        items.filter((i) => i.startsWith("Root cause established: yes")).length,
        payload,
      ).toBe(0);
    }
  });

  it("renders safe values readably", () => {
    for (const value of [
      "connection refused after 3 retries",
      "app/worker_pool-1.jsonl",
      "seq=1428",
      "utilisateur non trouvé — 사용자 없음",
    ]) {
      const html = renderInline(hostClaimLine(value));
      expect(html, value).toContain(value);
    }
  });
});
