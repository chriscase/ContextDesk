import { describe, expect, it, vi } from "vitest";
import {
  classifyCompletedCitation,
  openPersistedLogCitation,
  parseLogEventSeq,
  parseLogTemplateId,
} from "./citations";

describe("classifyCompletedCitation (#701)", () => {
  it("classifies Help, log, file, deferred, and invalid schemes", () => {
    expect(classifyCompletedCitation("help://log-explorer#lanes")).toBe(
      "help",
    );
    expect(classifyCompletedCitation("log_template:template-17")).toBe("log");
    expect(classifyCompletedCitation("log_event:event_42")).toBe("log");
    expect(classifyCompletedCitation("https://example.com/evidence")).toBe(
      "deferred",
    );
    expect(classifyCompletedCitation("memory:note-1")).toBe("deferred");
    expect(classifyCompletedCitation("custom:opaque")).toBe("invalid");
    expect(classifyCompletedCitation("log_template:")).toBe("invalid");
    expect(classifyCompletedCitation("log_event:42/../../secret")).toBe(
      "invalid",
    );
    expect(classifyCompletedCitation("relative/path.md")).toBe("file");
    expect(classifyCompletedCitation("C:\\workspace\\notes.md")).toBe("file");
  });

  it("parses numeric log identities for Explorer reveal", () => {
    expect(parseLogEventSeq("log_event:42")).toBe(42);
    expect(parseLogEventSeq("log_event:abc")).toBeNull();
    expect(parseLogTemplateId("log_template:7")).toBe(7);
    expect(parseLogTemplateId("log_template:x")).toBeNull();
  });
});

describe("openPersistedLogCitation (#698)", () => {
  it("never substitutes when provenance is missing", async () => {
    const open = vi.fn();
    const unavailable = vi.fn();
    await openPersistedLogCitation(
      "log_template:7",
      undefined,
      unavailable,
      open,
    );
    expect(open).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalled();
  });
});
