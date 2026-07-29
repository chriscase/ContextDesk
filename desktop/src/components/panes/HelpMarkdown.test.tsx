import { createRef } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
          "![Model context boundary](../assets/model-boundary.svg)",
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
          {
            path: "assets/model-boundary.svg",
            alt: "Model context boundary",
            mime: "image/svg+xml",
          },
        ]}
        assetUrls={{
          "assets/flow.svg": "data:image/svg+xml;base64,PHN2Zy8+",
          "assets/model-boundary.svg":
            "data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PScwIDAgMSAxJy8+",
        }}
        onOpenHelp={onOpenHelp}
        titleRef={titleRef}
      />,
    );

    expect(screen.getByRole("heading", { name: "Example", level: 1 })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Safe flow" }).getAttribute("src"),
    ).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(
      screen.getByRole("img", { name: "Model context boundary" }).getAttribute("src"),
    ).toBe("data:image/svg+xml;base64,PHN2ZyB2aWV3Qm94PScwIDAgMSAxJy8+");
    expect(screen.getByLabelText("Important")).toBeTruthy();
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert('no')</script>")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "help://permission-tiers" }));
    expect(onOpenHelp).toHaveBeenCalledWith("permission-tiers", undefined);
  });

  it("keeps clipboard denial visible and lets the user retry a fenced block", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <HelpMarkdown
        body={"```sh\nprintf 'safe command'\n```"}
        toc={[]}
        assets={[]}
        assetUrls={{}}
        onOpenHelp={vi.fn()}
        titleRef={createRef<HTMLHeadingElement>()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy sh block" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Copy sh block failed; retry",
        }),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "Could not copy sh block",
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Copy sh block failed; retry",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copied sh block" }),
      ).toBeTruthy(),
    );
    expect(writeText).toHaveBeenLastCalledWith("printf 'safe command'");
  });
});
