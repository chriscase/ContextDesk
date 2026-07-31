import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRef } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HelpTocEntryDto } from "../../lib/host";
import { HelpMarkdown } from "./HelpMarkdown";

const pageRaw = readFileSync(
  resolve(
    process.cwd(),
    "../docs/help/log-analysis/demo-datasets.md",
  ),
  "utf8",
);
const firstRunRaw = readFileSync(
  resolve(process.cwd(), "../docs/help/getting-started/first-run.md"),
  "utf8",
);

function bodyWithoutFrontmatter(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const close = lines.indexOf("---", 1);
  if (lines[0] !== "---" || close < 0) {
    throw new Error("demo Help page frontmatter is invalid");
  }
  return lines.slice(close + 1).join("\n");
}

function helpToc(body: string): HelpTocEntryDto[] {
  return body
    .split("\n")
    .flatMap((line) => {
      const match = line.match(/^(##|###)\s+(.+)$/);
      if (!match) return [];
      const title = match[2].trim();
      return [
        {
          level: match[1].length as 2 | 3,
          title,
          anchor: title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, ""),
        },
      ];
    });
}

const body = bodyWithoutFrontmatter(pageRaw);

function renderDemoHelp() {
  render(
    <HelpMarkdown
      body={body}
      toc={helpToc(body)}
      assets={[
        {
          path: "assets/log-analysis-pipeline.svg",
          alt: "Log analysis pipeline from ingest through redaction and analysis",
          mime: "image/svg+xml",
        },
      ]}
      assetUrls={{
        "assets/log-analysis-pipeline.svg":
          "data:image/svg+xml;base64,PHN2Zy8+",
      }}
      onOpenHelp={vi.fn()}
      titleRef={createRef<HTMLHeadingElement>()}
    />,
  );
}

function compactManifest(scenario: string) {
  return JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        `../fixtures/log-lab/scenarios/${scenario}/truth/manifest.json`,
      ),
      "utf8",
    ),
  ) as {
    expected: {
      bytes: number;
      events: number;
      files: number;
      time_quality: "wall" | "mixed" | "order_only";
    };
  };
}

describe("rendered demo-dataset Help (#715)", () => {
  it("keeps first-run Help explicit about opt-in, progress, idempotency, and truth isolation", () => {
    const normalized = firstRunRaw.replace(/\s+/g, " ");
    expect(normalized).toContain("Install demo log corpus");
    expect(normalized).toContain("unchecked by default");
    expect(normalized).toContain("25,000 entirely synthetic events");
    expect(normalized).toContain(
      "same bounded discover, streaming read/parse/template/persist",
    );
    expect(normalized).toContain("Repeating a successful install");
    expect(normalized).toContain("evaluator answer manifests");
    expect(normalized).toContain("Enter app · Open Logs");
  });

  it("renders safe import steps, portable path resolution, and the evaluator boundary", () => {
    renderDemoHelp();

    expect(
      screen.getByRole("heading", { name: "Try the demo log datasets" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: "Log analysis pipeline from ingest through redaction and analysis",
      }),
    ).toBeTruthy();

    const warning = screen.getByLabelText("Warning");
    expect(warning.textContent).toContain("NEVER import a `truth/` directory");
    expect(warning.textContent).toContain("must not enter a corpus");
    expect(warning.textContent).toContain("chat context");

    const pathCommand = screen
      .getAllByText((_content, element) => element?.tagName === "CODE")
      .find((element) => element.textContent?.includes("git rev-parse"));
    expect(pathCommand?.textContent).toContain(
      "fixtures/log-lab/scenarios/checkout-cascade/import",
    );
    expect(document.body.textContent).not.toContain("/Users/chriscase");
    expect(document.body.textContent).toContain(
      "bundles only the input logs for the pinned 25,000-event investigation",
    );
    expect(document.body.textContent).toContain(
      "does not contain evaluator truth",
    );
    expect(document.body.textContent).toContain(
      "same bounded ingest, redaction, diagnostics, and cancellation path",
    );

    const steps = screen
      .getAllByRole("list")
      .find((list) => list.textContent?.includes("Open Logs in the main window"));
    if (!steps) throw new Error("rendered import steps are missing");
    expect(steps.textContent).toContain("Open Logs in the main window");
    expect(steps.textContent).toContain("Choose Import logs");
    expect(steps.textContent).toContain(
      "select the scenario's exact import directory",
    );
  });

  it("copies the portable repository-relative path command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderDemoHelp();

    const pathCommand = screen
      .getAllByText((_content, element) => element?.tagName === "CODE")
      .find((element) => element.textContent?.includes("git rev-parse"));
    const pathCommandBlock = pathCommand?.closest(".help-code");
    if (!pathCommandBlock) {
      throw new Error("portable repository path command is missing");
    }
    fireEvent.click(
      within(pathCommandBlock as HTMLElement).getByRole("button", {
        name: "Copy sh block",
      }),
    );
    await waitFor(() =>
      expect(
        within(pathCommandBlock as HTMLElement).getByRole("button", {
          name: "Copied sh block",
        }),
      ).toBeTruthy(),
    );
    expect(writeText).toHaveBeenCalledWith(
      'cd "$(git rev-parse --show-toplevel)/fixtures/log-lab/scenarios/checkout-cascade/import" && pwd',
    );
    expect(
      within(pathCommandBlock as HTMLElement).getByRole("status").textContent,
    ).toBe(
      "sh block copied to clipboard",
    );
  });

  it("keeps every rendered compact-scenario result equal to its checked-in truth manifest", () => {
    renderDemoHelp();

    const scenarios = [
      "checkout-cascade",
      "company-known-noise",
      "company-original-fidelity",
      "company-timestamp-diversity",
      "importer-edge-cases",
      "mixed-time-quality",
      "redaction",
      "source-provenance",
    ];
    const qualityLabel = {
      wall: "wall clock",
      mixed: "mixed time",
      order_only: "order only",
    } as const;

    for (const scenario of scenarios) {
      const expected = compactManifest(scenario).expected;
      const row = screen
        .getAllByRole("row")
        .find((candidate) =>
          candidate.textContent?.startsWith(scenario),
        );
      expect(row, `missing rendered row for ${scenario}`).toBeTruthy();
      expect(row?.textContent).toContain(
        `${expected.events.toLocaleString("en-US")} events`,
      );
      expect(row?.textContent).toContain(
        `${expected.files.toLocaleString("en-US")} ${scenario === "importer-edge-cases" ? "discovered " : ""}${expected.files === 1 ? "file" : "files"}`,
      );
      expect(row?.textContent).toContain(
        `${expected.bytes.toLocaleString("en-US")} source bytes`,
      );
      expect(row?.textContent).toContain(
        qualityLabel[expected.time_quality],
      );
    }
  });

  it("renders the golden-corpus identity and optional metrics from checked-in fixtures", () => {
    renderDemoHelp();

    const golden = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "../fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/truth/manifest.json",
        ),
        "utf8",
      ),
    ) as {
      expected: {
        bytes: number;
        events: number;
        files: number;
        severities: Record<string, number>;
      };
    };
    const metrics = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "../fixtures/log-lab/acceptance/seven-day-25k/scenarios/behavior-scale/metrics/operational-metrics.v1.json",
        ),
        "utf8",
      ),
    ) as {
      series: Array<{
        id: string;
        points: Array<{ value: number }>;
      }>;
    };

    expect(document.body.textContent).toContain(
      `${golden.expected.events.toLocaleString("en-US")} events`,
    );
    expect(document.body.textContent).toContain(
      `${golden.expected.files.toLocaleString("en-US")} files`,
    );
    expect(document.body.textContent).toContain(
      `${golden.expected.bytes.toLocaleString("en-US")} source bytes`,
    );
    for (const [level, count] of Object.entries(golden.expected.severities)) {
      expect(document.body.textContent).toContain(
        `${count.toLocaleString("en-US")} ${level.toUpperCase()}`,
      );
    }

    const labels: Record<string, string> = {
      "cpu-percent": "CPU",
      "heap-used-bytes": "Heap used",
      "concurrent-clients": "Concurrent clients",
    };
    for (const series of metrics.series) {
      const row = screen
        .getAllByRole("row")
        .find((candidate) =>
          candidate.textContent?.startsWith(labels[series.id] ?? series.id),
        );
      const values = series.points.map((point) => point.value);
      expect(row, `missing rendered metric row for ${series.id}`).toBeTruthy();
      expect(row?.textContent).toContain(`${series.points.length} points`);
      expect(row?.textContent).toContain(
        Math.min(...values).toLocaleString("en-US"),
      );
      expect(row?.textContent).toContain(
        Math.max(...values).toLocaleString("en-US"),
      );
    }

    expect(document.body.textContent).toContain(
      "If you do not load this file, the CPU, heap, and client tracks remain absent",
    );
    expect(document.body.textContent).toContain(
      "The validated stored copy is attached to this exact corpus and restores after Explorer or application restart",
    );
  });
});
