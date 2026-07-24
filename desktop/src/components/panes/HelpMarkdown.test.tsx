import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  HelpMarkdown,
  __helpMarkdownTest,
} from "./HelpMarkdown";

describe("HelpMarkdown trusted static renderer (#438)", () => {
  it("parses only strict help locators and resolves declared assets", () => {
    expect(__helpMarkdownTest.parseHelpLocator("help://log-analysis-pipeline#pipeline"))
      .toEqual({
        pageId: "log-analysis-pipeline",
        anchor: "pipeline",
      });
    expect(__helpMarkdownTest.parseHelpLocator("https://example.com")).toBeNull();
    expect(__helpMarkdownTest.parseHelpLocator("help://../secret")).toBeNull();
    expect(
      __helpMarkdownTest.imageAssetPath("../assets/flow.svg", [
        { path: "assets/flow.svg", alt: "Flow", mime: "image/svg+xml" },
      ]),
    ).toBe("assets/flow.svg");
  });

  it("renders headings, tables, callouts, SVG images, and internal links without raw HTML", () => {
    const onOpenHelp = vi.fn();
    const titleRef = createRef<HTMLHeadingElement>();
    render(
      <HelpMarkdown
        body={[
          "# Example",
          "",
          "<script>alert('no')</script>",
          "",
          "![Safe flow](../assets/flow.svg)",
          "",
          "## Matrix",
          "",
          "| State | Meaning |",
          "| --- | --- |",
          "| Ready | Continue |",
          "",
          "> Important:",
          "> Inspect the result.",
          "",
          "Read help://permission-tiers.",
        ].join("\n")}
        toc={[{ level: 2, title: "Matrix", anchor: "matrix" }]}
        assets={[
          { path: "assets/flow.svg", alt: "Safe flow", mime: "image/svg+xml" },
        ]}
        assetUrls={{ "assets/flow.svg": "data:image/svg+xml;base64,PHN2Zy8+" }}
        onOpenHelp={onOpenHelp}
        titleRef={titleRef}
      />,
    );

    expect(screen.getByRole("heading", { name: "Example", level: 1 })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Safe flow" }).getAttribute("src"),
    ).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(screen.getByLabelText("Important")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert('no')</script>")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "help://permission-tiers" }));
    expect(onOpenHelp).toHaveBeenCalledWith("permission-tiers", undefined);
  });
});
