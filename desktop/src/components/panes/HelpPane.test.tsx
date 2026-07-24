import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostGetHelpAsset,
  hostGetHelpPage,
  hostListHelpSections,
  hostSearchHelpPages,
} from "../../lib/host";
import { HelpPane } from "./HelpPane";

vi.mock("../../lib/host", () => ({
  hostListHelpSections: vi.fn(),
  hostGetHelpPage: vi.fn(),
  hostGetHelpAsset: vi.fn(),
  hostSearchHelpPages: vi.fn(),
}));

const sections = [
  {
    id: "overview",
    title: "Overview",
    order: 10,
    pages: [
      {
        id: "product-overview",
        title: "What ContextDesk does",
        summary: "Understand the product.",
        order: 10,
        tags: ["overview"],
      },
    ],
  },
  {
    id: "log-analysis",
    title: "Log analysis",
    order: 70,
    pages: [
      {
        id: "log-analysis-pipeline",
        title: "How log analysis works",
        summary: "Follow the bounded pipeline.",
        order: 10,
        tags: ["logs"],
      },
    ],
  },
];

const overviewPage = {
  meta: {
    ...sections[0].pages[0],
    section: "overview",
    related: ["log-analysis-pipeline"],
  },
  body: [
    "# What ContextDesk does",
    "",
    "Bundled, local product guidance.",
    "",
    "![Architecture flow](../assets/product-architecture.svg)",
    "",
    "## Boundaries",
    "",
    "| Layer | Responsibility |",
    "| --- | --- |",
    "| Host | Trusted reads |",
  ].join("\n"),
  toc: [{ level: 2 as const, title: "Boundaries", anchor: "boundaries" }],
  assets: [
    {
      path: "assets/product-architecture.svg",
      alt: "Architecture flow",
      mime: "image/svg+xml",
    },
  ],
};

const logPage = {
  meta: {
    ...sections[1].pages[0],
    section: "log-analysis",
    related: [],
  },
  body: "# How log analysis works\n\n## Pipeline\n\nIngest, redact, store, analyze.",
  toc: [{ level: 2 as const, title: "Pipeline", anchor: "pipeline" }],
  assets: [],
};

describe("HelpPane product path (#438)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hostListHelpSections).mockResolvedValue(sections);
    vi.mocked(hostGetHelpPage).mockImplementation(async (id) =>
      id === "log-analysis-pipeline" ? logPage : overviewPage,
    );
    vi.mocked(hostGetHelpAsset).mockResolvedValue({
      mime: "image/svg+xml",
      data_url: "data:image/svg+xml;base64,PHN2Zy8+",
    });
    vi.mocked(hostSearchHelpPages).mockResolvedValue([
      {
        page_id: "log-analysis-pipeline",
        title: "How log analysis works",
        summary: "Follow the bounded pipeline.",
        section: "log-analysis",
        heading: "Pipeline",
        anchor: "pipeline",
        snippet: "Ingest, redact, store, and analyze a bounded corpus.",
        score: 0.92,
        mode: "keyword",
        citation: "help://log-analysis-pipeline#pipeline",
      },
    ]);
  });

  it("loads bundled navigation, article, table, and trusted SVG through host commands", async () => {
    render(<HelpPane />);

    expect(await screen.findByRole("heading", { name: "What ContextDesk does" }))
      .toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Help sections" })).toBeTruthy();
    expect(screen.getByRole("main", { name: "Help article" })).toBeTruthy();
    expect(screen.getByRole("complementary", { name: "On this page" })).toBeTruthy();
    expect(screen.getByRole("table")).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "Architecture flow" }).getAttribute("src"),
    ).toBe("data:image/svg+xml;base64,PHN2Zy8+");
    expect(hostGetHelpAsset).toHaveBeenCalledWith(
      "product-overview",
      "assets/product-architecture.svg",
    );
  });

  it("searches locally, exposes ranking mode, and opens the selected deep result", async () => {
    render(<HelpPane />);
    await screen.findByRole("heading", { name: "What ContextDesk does" });

    fireEvent.change(screen.getByRole("searchbox", { name: "Search Help" }), {
      target: { value: "log analysis" },
    });

    expect(
      await screen.findByRole("button", { name: /How log analysis works/ }),
    ).toBeTruthy();
    expect(screen.getByText("Keyword")).toBeTruthy();
    expect(screen.getByLabelText("Relevance score 0.92")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("searchbox", { name: "Search Help" }), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(hostGetHelpPage).toHaveBeenCalledWith("log-analysis-pipeline"),
    );
    expect(
      await screen.findByRole("heading", { name: "How log analysis works" }),
    ).toBeTruthy();
  });

  it("retains and resolves a page deep link delivered with pane activation", async () => {
    render(
      <HelpPane
        request={{
          requestId: 7,
          pageId: "log-analysis-pipeline",
          anchor: "pipeline",
        }}
      />,
    );
    expect(
      await screen.findByRole("heading", { name: "How log analysis works" }),
    ).toBeTruthy();
    expect(hostGetHelpPage).toHaveBeenCalledWith("log-analysis-pipeline");
  });

  it("focuses local search when the palette hands off Search Help", async () => {
    render(
      <HelpPane
        request={{
          requestId: 8,
          focusSearch: true,
        }}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "Search Help" });
    await waitFor(() => expect(document.activeElement).toBe(search));
  });
});
