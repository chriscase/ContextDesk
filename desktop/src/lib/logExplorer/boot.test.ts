import { describe, expect, it } from "vitest";
import { parseExplorerBoot } from "./boot";

describe("parseExplorerBoot", () => {
  it("reads query window=log-explorer&corpus=", () => {
    const b = parseExplorerBoot("?window=log-explorer&corpus=abc-123", "");
    expect(b).toEqual({ mode: "explorer", corpusId: "abc-123", corpusName: null });
  });

  it("carries the URL-encoded display name for the window title (#641)", () => {
    const b = parseExplorerBoot(
      "?window=log-explorer&corpus=abc-123&name=caf%C3%A9%20cascade%20%E2%80%94%20prod",
      "",
    );
    expect(b).toEqual({
      mode: "explorer",
      corpusId: "abc-123",
      corpusName: "café cascade — prod",
    });
  });

  it("treats a blank name param as absent", () => {
    const b = parseExplorerBoot("?window=log-explorer&corpus=abc-123&name=", "");
    expect(b).toEqual({ mode: "explorer", corpusId: "abc-123", corpusName: null });
  });

  it("returns explorer with empty corpus when corpus missing", () => {
    const b = parseExplorerBoot("?window=log-explorer", "");
    expect(b).toEqual({ mode: "explorer", corpusId: "", corpusName: null });
  });

  it("defaults to app for main window", () => {
    expect(parseExplorerBoot("", "")).toEqual({ mode: "app" });
    expect(parseExplorerBoot("?foo=1", "")).toEqual({ mode: "app" });
  });

  it("boots the isolated engineering handbook window", () => {
    expect(parseExplorerBoot("?window=engineering-handbook", "")).toEqual({
      mode: "handbook",
    });
  });
});
