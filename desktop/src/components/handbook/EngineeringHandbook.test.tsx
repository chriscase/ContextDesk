import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostGetHandbookManifest,
  hostGetHandbookPage,
  hostOpenExternalUrl,
  hostResolveHandbookLink,
} from "../../lib/host";
import { EngineeringHandbook } from "./EngineeringHandbook";

vi.mock("../../lib/host", () => ({
  hostGetHandbookManifest: vi.fn(),
  hostGetHandbookPage: vi.fn(),
  hostOpenExternalUrl: vi.fn(),
  hostResolveHandbookLink: vi.fn(),
}));

const manifest = {
  title: "ContextDesk Engineering Handbook",
  audience: "Engineers, reviewers, and technical leaders",
  chapters: [
    { id: "architecture", title: "Architecture" },
    { id: "evidence", title: "Governed evidence" },
  ],
};

const pages = {
  architecture: {
    id: "architecture",
    title: "Architecture",
    body: [
      "# Architecture",
      "",
      "The host enforces [trust boundaries](https://example.test/trust).",
      "",
      "## Components",
      "",
      "Read-only components.",
    ].join("\n"),
  },
  evidence: {
    id: "evidence",
    title: "Governed evidence",
    body: "# Governed evidence\n\n## Collection\n\nEvidence stays bounded.",
  },
};

describe("EngineeringHandbook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hostGetHandbookManifest).mockResolvedValue(manifest);
    vi.mocked(hostGetHandbookPage).mockImplementation(async (id: string) => {
      return pages[id as keyof typeof pages];
    });
    vi.mocked(hostOpenExternalUrl).mockResolvedValue();
    vi.mocked(hostResolveHandbookLink).mockResolvedValue({
      kind: "internal",
      pageId: "evidence",
      anchor: "collection",
    });
  });

  it("loads the manifest and first chapter, then navigates with focus restoration", async () => {
    const { container } = render(<EngineeringHandbook />);

    expect(screen.getByLabelText("Loading chapter").textContent).toContain(
      "Opening",
    );
    expect(
      container.querySelector(".handbook-header__identity svg"),
    ).toBeTruthy();
    expect(
      await screen.findByRole("heading", { name: "Architecture", level: 1 }),
    ).toBeTruthy();
    expect(hostGetHandbookManifest).toHaveBeenCalledTimes(1);
    expect(hostGetHandbookPage).toHaveBeenCalledWith("architecture");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Architecture", level: 1 }),
      ),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /02 Governed evidence/i }),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Governed evidence",
        level: 1,
      }),
    ).toBeTruthy();
    expect(hostGetHandbookPage).toHaveBeenCalledWith("evidence");
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", {
          name: "Governed evidence",
          level: 1,
        }),
      ),
    );
  });

  it("supports arrow-key movement through chapter navigation", async () => {
    render(<EngineeringHandbook />);
    await screen.findByRole("heading", { name: "Architecture", level: 1 });

    const architecture = screen.getByRole("button", {
      name: /01 Architecture/i,
    });
    const evidence = screen.getByRole("button", {
      name: /02 Governed evidence/i,
    });
    architecture.focus();
    fireEvent.keyDown(architecture, { key: "ArrowDown" });
    expect(document.activeElement).toBe(evidence);
    fireEvent.keyDown(evidence, { key: "Home" });
    expect(document.activeElement).toBe(architecture);
  });

  it("tracks the independently scrolled chapter in the on-page outline", async () => {
    vi.mocked(hostGetHandbookPage).mockResolvedValueOnce({
      ...pages.architecture,
      body: [
        "# Architecture",
        "",
        "## Components",
        "",
        "Read-only components.",
        "",
        "## Trust boundary",
        "",
        "The host remains authoritative.",
      ].join("\n"),
    });
    const { container } = render(<EngineeringHandbook />);
    await screen.findByRole("heading", { name: "Trust boundary", level: 2 });

    const reader = container.querySelector<HTMLElement>(".handbook-reader");
    const components = document.getElementById("components");
    const trustBoundary = document.getElementById("trust-boundary");
    expect(reader).toBeTruthy();
    expect(components).toBeTruthy();
    expect(trustBoundary).toBeTruthy();
    Object.defineProperty(components, "offsetTop", {
      configurable: true,
      value: 120,
    });
    Object.defineProperty(trustBoundary, "offsetTop", {
      configurable: true,
      value: 720,
    });
    Object.defineProperty(reader, "scrollTop", {
      configurable: true,
      writable: true,
      value: 700,
    });

    fireEvent.scroll(reader as HTMLElement);
    await waitFor(() =>
      expect(
        screen
          .getByRole("button", { name: "Trust boundary" })
          .getAttribute("aria-current"),
      ).toBe("location"),
    );
    expect(
      screen
        .getByRole("button", { name: "Components" })
        .getAttribute("aria-current"),
    ).toBeNull();
  });

  it("routes Markdown links to the supplied callback with the raw target", async () => {
    const onNavigate = vi.fn();
    render(<EngineeringHandbook onNavigate={onNavigate} />);
    await screen.findByRole("heading", { name: "Architecture", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: /trust boundaries/i }));
    expect(onNavigate).toHaveBeenCalledWith("https://example.test/trust");
    expect(hostOpenExternalUrl).not.toHaveBeenCalled();
  });

  it("uses the host external-navigation command when no callback is supplied", async () => {
    render(<EngineeringHandbook />);
    await screen.findByRole("heading", { name: "Architecture", level: 1 });

    fireEvent.click(screen.getByRole("button", { name: /trust boundaries/i }));
    await waitFor(() =>
      expect(hostOpenExternalUrl).toHaveBeenCalledWith(
        "https://example.test/trust",
      ),
    );
  });

  it("resolves bundled relative links in the host before changing chapters", async () => {
    vi.mocked(hostGetHandbookPage).mockResolvedValueOnce({
      ...pages.architecture,
      body: "# Architecture\n\nRead the [evidence chapter](evidence.md#collection).",
    });
    render(<EngineeringHandbook />);
    const architectureHeading = await screen.findByRole("heading", {
      name: "Architecture",
      level: 1,
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(architectureHeading),
    );

    fireEvent.click(screen.getByRole("button", { name: /evidence chapter/i }));
    await waitFor(() =>
      expect(hostResolveHandbookLink).toHaveBeenCalledWith(
        "architecture",
        "evidence.md#collection",
      ),
    );
    expect(
      await screen.findByRole("heading", {
        name: "Governed evidence",
        level: 1,
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("heading", { name: "Collection", level: 2 }),
      ),
    );
  });

  it("shows a useful error and retries a failed chapter", async () => {
    vi.mocked(hostGetHandbookPage)
      .mockRejectedValueOnce(new Error("Bundle checksum did not match"))
      .mockResolvedValueOnce(pages.architecture);

    render(<EngineeringHandbook />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Bundle checksum did not match",
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByRole("heading", { name: "Architecture", level: 1 }),
    ).toBeTruthy();
    expect(hostGetHandbookPage).toHaveBeenCalledTimes(2);
  });

  it("reports a manifest failure without offering a misleading retry", async () => {
    vi.mocked(hostGetHandbookManifest).mockRejectedValue(
      new Error("Handbook is not bundled"),
    );

    render(<EngineeringHandbook />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Handbook is not bundled",
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
