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
    const { container } = render(
      <HandbookMarkdown body={body} headings={headings} onNavigate={vi.fn()} />,
    );

    const diagram = screen.getByRole("figure", {
      name: "System flow",
    });
    expect(diagram.textContent).toContain("Source logs leads to Trusted host");
    expect(diagram.textContent).toContain(
      "Trusted host leads to Selected model",
    );
    const svg = container.querySelector(".handbook-diagram__canvas svg");
    expect(svg).toBeTruthy();
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    expect(svg?.textContent).toContain("Source logs");
    expect(svg?.textContent).toContain("Trusted host");
    expect(svg?.querySelectorAll(".handbook-diagram__svg-node").length).toBe(3);
    expect(svg?.querySelectorAll(".handbook-diagram__svg-edge").length).toBe(2);
    expect(svg?.getAttribute("data-layout")).toBe("lr");
    expect(
      svg?.querySelector(".handbook-diagram__svg-node")?.getAttribute("fill"),
    ).toBeNull();
    expect(
      svg?.querySelector(".handbook-diagram__svg-edge")?.getAttribute("stroke"),
    ).toBeNull();
    expect(screen.getByText("Read diagram source")).toBeTruthy();

    fireEvent.click(screen.getByText("Read diagram source"));
    expect(screen.getByText(/flowchart LR/)).toBeTruthy();
  });

  it("adapts an over-wide flow into a readable vertical overview", () => {
    const wideFlow = [
      "```mermaid",
      "flowchart LR",
      '  A["One"] --> B["Two"] --> C["Three"] --> D["Four"]',
      '  D --> E["Five"] --> F["Six"]',
      "  D --> F",
      "```",
    ].join("\n");
    const { container } = render(
      <HandbookMarkdown body={wideFlow} headings={[]} onNavigate={vi.fn()} />,
    );
    const svg = container.querySelector(".handbook-diagram__canvas svg");

    expect(svg?.getAttribute("data-layout")).toBe("responsive-top-to-bottom");
    expect(svg?.getAttribute("style")).toBeNull();
    expect(svg?.querySelectorAll(".handbook-diagram__svg-node").length).toBe(6);
    expect(svg?.querySelectorAll(".handbook-diagram__svg-edge").length).toBe(6);
    const skipEdge = svg?.querySelector('[data-edge="D-F"]');
    const skipPathNumbers = [
      ...(skipEdge?.getAttribute("d") ?? "").matchAll(/\d+/g),
    ].map(([value]) => Number(value));
    expect(skipPathNumbers[2]).toBeGreaterThan(skipPathNumbers[0] + 100);
  });

  it("renders a labeled sequence SVG and fails visibly for unsupported syntax", () => {
    const sequence = [
      "```mermaid",
      "sequenceDiagram",
      "  actor U as User",
      "  participant H as Trusted host",
      "  U->>H: Ask a bounded question",
      "  H-->>U: Return cited evidence",
      "```",
      "",
      "```mermaid",
      "journey",
      "  title Unsupported example",
      "```",
    ].join("\n");
    const { container } = render(
      <HandbookMarkdown body={sequence} headings={[]} onNavigate={vi.fn()} />,
    );

    expect(
      screen.getByRole("figure", { name: "Context sequence" }).textContent,
    ).toContain("User sends “Ask a bounded question” to Trusted host");
    const sequenceSvg = container.querySelector(
      ".handbook-diagram__canvas svg",
    );
    expect(sequenceSvg?.textContent).toContain("User");
    expect(sequenceSvg?.textContent).toContain("Trusted host");
    expect(sequenceSvg?.textContent).toContain("Ask a bounded question");

    const unsupported = screen.getByText(/unsupported Mermaid syntax/i);
    expect(unsupported).toBeTruthy();
    expect(
      unsupported.closest("figure")?.querySelector(".handbook-diagram__canvas"),
    ).toBeNull();
  });

  it("uses authored diagram titles and fails closed on partial semantics", () => {
    const complex = [
      "```mermaid",
      "sequenceDiagram",
      "  %% title: Governed context assembly",
      "  actor U as User",
      "  participant H as Trusted host",
      "  alt Tools unavailable",
      "    H-->>U: Show an honest failure",
      "  end",
      "```",
      "",
      "```mermaid",
      "flowchart TB",
      "  %% title: Permission boundary",
      "  subgraph Trusted",
      '    H["Host"]',
      "  end",
      '  U["Untrusted input"] --> H',
      "```",
    ].join("\n");
    const { container } = render(
      <HandbookMarkdown body={complex} headings={[]} onNavigate={vi.fn()} />,
    );

    expect(
      screen.getByRole("figure", { name: "Governed context assembly" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("figure", { name: "Permission boundary" }),
    ).toBeTruthy();
    expect(screen.getAllByText(/unsupported Mermaid syntax/i)).toHaveLength(2);
    expect(
      container.querySelectorAll(".handbook-diagram__canvas"),
    ).toHaveLength(0);
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
