import { describe, expect, it } from "vitest";
import { classifyProbeDiagnostics } from "./ProbeDiagnostics";

describe("classifyProbeDiagnostics", () => {
  it("detects rate limit", () => {
    expect(
      classifyProbeDiagnostics(
        ["https://gw/v1/models: HTTP 429"],
        ["Checking gateway…"],
      ),
    ).toBe("rate_limited");
  });

  it("detects auth", () => {
    expect(
      classifyProbeDiagnostics(
        ["https://gw/v1/models: auth failed (401) — check API key"],
        [],
      ),
    ).toBe("auth");
  });

  it("detects unreachable", () => {
    expect(
      classifyProbeDiagnostics(
        ["https://gw/v1/models: error sending request for url: dns error"],
        [],
      ),
    ).toBe("unreachable");
  });
});
