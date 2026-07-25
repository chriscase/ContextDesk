/**
 * Structural tests for Logs list|detail chrome (no Tauri).
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { LogPane } from "./LogPane";

vi.mock("../../lib/host", () => ({
  hostListLogCorpora: vi.fn(async () => []),
  hostListenProcessProgress: vi.fn(async () => () => {}),
  hostDiscardLogCorpus: vi.fn(),
  hostExportLogCorpusPackage: vi.fn(),
  hostImportLogCorpusPackagePath: vi.fn(),
  hostIngestLogPath: vi.fn(),
  hostListLogTemplates: vi.fn(),
  hostLogClusterProblems: vi.fn(),
  hostLogSearch: vi.fn(),
  hostLogTimeline: vi.fn(),
  hostSetActiveLogCorpus: vi.fn(),
}));

vi.mock("../../lib/dialogs", () => ({
  dialogConfirm: vi.fn(async () => false),
  openDirectoryDialog: vi.fn(async () => null),
  openFileDialog: vi.fn(async () => null),
  saveFileDialog: vi.fn(async () => null),
}));

describe("LogPane", () => {
  it("renders folder and zip import actions and empty state", async () => {
    render(<LogPane />);
    expect(screen.getByTestId("log-pane")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: /Import folder/i }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      screen.getAllByRole("button", { name: /Import file \/ zip/i }).length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /Import package/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Export package/i })).toBeTruthy();
    expect(await screen.findByText(/No corpora yet/i)).toBeTruthy();
  });
});
