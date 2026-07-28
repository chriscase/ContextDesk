import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  collectHandbookHeadings,
  HandbookMarkdown,
  HandbookTableOfContents,
} from "./HandbookMarkdown";

const body = [
  "# Proven **methods**",
  "",
  "Read the [design source](https://example.test/design) with `care` and *judgment*.",
  "",
  "## Pipeline",
  "",
  "- Collect bounded evidence",
  "- Redact secrets",
  "",
  "### Trust boundary",
  "",
  "| Stage | Promise |",
  "| --- | --- |",
  "| Host | **Read-only** |",
  "",
  "```rust",
  "fn bounded() -> bool { true }",
  "```",
  "",
  "```mermaid",
  "flowchart LR",
  "  Logs[Source logs] --> Host[Trusted host]",
  "  Host --> Model[Selected model]",
  "```",
].join("\n");

describe("HandbookMarkdown", () => {
  it("renders the supported safe subset and routes raw link targets", () => {
    const onNavigate = vi.fn();
    const headings = collectHandbookHeadings(body);
    const { container } = render(
      <HandbookMarkdown
        body={`${body}\n\n<script>unsafe()</script>`}
        headings={headings}
        onNavigate={onNavigate}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Proven methods", level: 1 }),
    ).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("fn bounded() -> bool { true }")).toBeTruthy();
    expect(screen.getByText("care").tagName).toBe("CODE");
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>unsafe()</script>")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /design source/i }));
    expect(onNavigate).toHaveBeenCalledWith("https://example.test/design");
    expect(container.querySelector("a")).toBeNull();
  });

  it("presents Mermaid as an accessible semantic card and readable source", () => {
    const headings = collectHandbookHeadings(body);
    render(
      <HandbookMarkdown body={body} headings={headings} onNavigate={vi.fn()} />,
    );

    const diagram = screen.getByRole("figure", {
      name: "Architecture diagram",
    });
    expect(diagram.textContent).toContain("Source logs leads to Trusted host");
    expect(diagram.textContent).toContain(
      "Trusted host leads to Selected model",
    );
    expect(screen.getByText("Read diagram source")).toBeTruthy();

    fireEvent.click(screen.getByText("Read diagram source"));
    expect(screen.getByText(/flowchart LR/)).toBeTruthy();
  });

  it("builds stable unique heading ids and keyboard-operable local navigation", () => {
    const headings = collectHandbookHeadings(
      [
        "# One",
        "",
        "```markdown",
        "## Not a heading",
        "```",
        "",
        "## Repeat",
        "",
        "### Repeat",
        "",
        "#### Detail",
      ].join("\n"),
    );
    expect(headings.map((heading) => heading.id)).toEqual([
      "one",
      "repeat",
      "repeat-2",
      "detail",
    ]);

    const scrollTo = vi.fn();
    const onActivate = vi.fn();
    render(
      <>
        <HandbookTableOfContents
          headings={headings}
          activeHeadingId="repeat"
          onActivate={onActivate}
        />
        <main
          className="handbook-reader"
          ref={(node) => {
            if (node) node.scrollTo = scrollTo;
          }}
        >
          {headings.map((heading) => (
            <h2 id={heading.id} tabIndex={-1} key={heading.id}>
              Target {heading.title}
            </h2>
          ))}
        </main>
      </>,
    );

    const repeatButtons = screen.getAllByRole("button", { name: "Repeat" });
    expect(repeatButtons[0].getAttribute("aria-current")).toBe("location");
    repeatButtons[0].focus();
    fireEvent.keyDown(repeatButtons[0], { key: "ArrowDown" });
    expect(document.activeElement).toBe(repeatButtons[1]);
    fireEvent.click(repeatButtons[1]);
    expect(onActivate).toHaveBeenCalledWith("repeat-2");
    expect(document.activeElement).toBe(document.getElementById("repeat-2"));
    expect(scrollTo).toHaveBeenCalled();
  });
});
