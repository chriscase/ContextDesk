import { describe, expect, it } from "vitest";
import { parseExplorerBoot } from "./boot";

describe("parseExplorerBoot", () => {
  it("reads query window=log-explorer&corpus=", () => {
    const b = parseExplorerBoot(
      "?window=log-explorer&corpus=abc-123",
      "",
    );
    expect(b).toEqual({ mode: "explorer", corpusId: "abc-123" });
  });

  it("returns explorer with empty corpus when corpus missing", () => {
    const b = parseExplorerBoot("?window=log-explorer", "");
    expect(b).toEqual({ mode: "explorer", corpusId: "" });
  });

  it("defaults to app for main window", () => {
    expect(parseExplorerBoot("", "")).toEqual({ mode: "app" });
    expect(parseExplorerBoot("?foo=1", "")).toEqual({ mode: "app" });
  });
});
