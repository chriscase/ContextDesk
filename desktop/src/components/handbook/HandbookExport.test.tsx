import { describe, expect, it } from "vitest";
import type { HandbookLinkDto } from "../../lib/host";
import { renderHandbookExportHtml } from "./HandbookExport";

const manifest = {
  title: "ContextDesk Engineering Handbook",
  audience: "Engineers and reviewers",
  chapters: [
    { id: "docs/design/PROVEN_METHODS.md", title: "Proven methods" },
    {
      id: "docs/design/proven-methods/PIPELINE.md",
      title: "Evidence pipeline",
    },
  ],
};

const pages = [
  {
    id: manifest.chapters[0].id,
    title: manifest.chapters[0].title,
    body: [
      "# Proven methods",
      "",
      "## Boundary",
      "",
      "Read the [pipeline](proven-methods/PIPELINE.md#stages) and [project](https://example.test/project).",
    ].join("\n"),
  },
  {
    id: manifest.chapters[1].id,
    title: manifest.chapters[1].title,
    body: [
      "# Evidence pipeline",
      "",
      "## Stages",
      "",
      "```mermaid",
      "flowchart LR",
      '  A["Raw evidence"] --> B["Bounded context"]',
      "```",
    ].join("\n"),
  },
];

describe("handbook HTML export", () => {
  it("produces one inert portable document with stable links and inline SVG", async () => {
    const resolveLink = async (
      _fromPageId: string,
      target: string,
    ): Promise<HandbookLinkDto> => {
      if (target.startsWith("https://")) {
        return { kind: "external", url: target };
      }
      return {
        kind: "internal",
        pageId: pages[1].id,
        anchor: "stages",
      };
    };
    const html = await renderHandbookExportHtml(manifest, pages, resolveLink);

    expect(html).toContain('data-contextdesk-handbook-export="1"');
    expect(html).toContain('href="#proven-methods-pipeline--stages"');
    expect(html).toContain('href="https://example.test/project"');
    expect(html).toContain("<svg");
    expect(html).toContain("Raw evidence");
    expect(html).toContain("Bounded context");
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html.toLowerCase()).not.toContain("<script");
    expect(html.toLowerCase()).not.toContain(" src=");
    expect(html).not.toContain("<button");

    const document = new DOMParser().parseFromString(html, "text/html");
    const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(
      document.querySelector(
        "#proven-methods-pipeline--handbook-diagram-arrow-2",
      ),
    ).toBeTruthy();
    expect(
      document
        .querySelector(".handbook-diagram__svg-edge")
        ?.getAttribute("marker-end"),
    ).toBe("url(#proven-methods-pipeline--handbook-diagram-arrow-2)");
  });

  it("degrades an unresolvable Markdown link to inert text", async () => {
    const html = await renderHandbookExportHtml(
      { ...manifest, chapters: [manifest.chapters[0]] },
      [pages[0]],
      async () => {
        throw new Error("not bundled");
      },
    );
    const document = new DOMParser().parseFromString(html, "text/html");
    expect(document.body.textContent).toContain("pipeline");
    expect(document.querySelector('a[href*="PIPELINE"]')).toBeNull();
  });
});
