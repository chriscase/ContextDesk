import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  classifyCompletedCitation,
  formatGovernedLogCitationId,
  governedIdToSafeInteger,
  isGovernedLogCitationId,
  openPersistedLogCitation,
  parseGovernedLogCitationId,
  parseLogEventSeq,
  parseLogTemplateId,
} from "./citations";

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/log-lab/governed-log-citation-ids.v1.json",
);

type AcceptCase = {
  input: string;
  kind: "event" | "template";
  id: string;
  js_safe_integer?: boolean;
};

type RejectCase = {
  input: string;
  reason: string;
};

type Fixture = {
  catalog_version: string;
  accept: AcceptCase[];
  reject: RejectCase[];
};

const fixture: Fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));

describe("governed log citation id contract (shared fixture)", () => {
  it("uses the shared catalog version", () => {
    expect(fixture.catalog_version).toBe(
      "contextdesk.governed_log_citation_ids.v1",
    );
  });

  it("accepts exactly the shared accept vectors", () => {
    for (const case_ of fixture.accept) {
      const parsed = parseGovernedLogCitationId(case_.input);
      expect(parsed, `accept ${case_.input}`).toEqual({
        kind: case_.kind,
        id: case_.id,
      });
      expect(isGovernedLogCitationId(case_.input)).toBe(true);
      // Round-trip via format uses canonical (trimmed) form.
      expect(
        parseGovernedLogCitationId(
          formatGovernedLogCitationId(case_.kind, case_.id),
        ),
      ).toEqual({ kind: case_.kind, id: case_.id });
    }
  });

  it("rejects exactly the shared reject vectors", () => {
    for (const case_ of fixture.reject) {
      expect(
        parseGovernedLogCitationId(case_.input),
        `reject ${case_.input} (${case_.reason})`,
      ).toBeNull();
      expect(isGovernedLogCitationId(case_.input)).toBe(false);
    }
  });

  it("never silently widens IDs past Number.MAX_SAFE_INTEGER", () => {
    // The adversarial value from the goal statement.
    const raw = "log_event:9007199254740993";
    const parsed = parseGovernedLogCitationId(raw);
    expect(parsed).toEqual({ kind: "event", id: "9007199254740993" });
    // Number() would coerce this to 9007199254740992 — must not.
    expect(Number("9007199254740993")).toBe(9007199254740992);
    expect(governedIdToSafeInteger("9007199254740993")).toBeNull();
    expect(parseLogEventSeq(raw)).toBeNull();
    // String identity preserved end-to-end.
    expect(parsed!.id).toBe("9007199254740993");
    expect(parsed!.id).not.toBe(String(Number(parsed!.id)));
  });

  it("allows Number only under Number.isSafeInteger", () => {
    expect(governedIdToSafeInteger("42")).toBe(42);
    expect(governedIdToSafeInteger("9007199254740991")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(governedIdToSafeInteger("9007199254740992")).toBeNull();
    expect(governedIdToSafeInteger("18446744073709551615")).toBeNull();
    expect(parseLogEventSeq("log_event:42")).toBe(42);
    expect(parseLogTemplateId("log_template:7")).toBe(7);
    expect(parseLogEventSeq("log_event:18446744073709551615")).toBeNull();
    expect(parseLogTemplateId("log_template:9007199254740993")).toBeNull();
  });

  it("rejects uppercase, overflow, and malformed grammar", () => {
    expect(parseGovernedLogCitationId("LOG_EVENT:42")).toBeNull();
    expect(parseGovernedLogCitationId("log_event:01")).toBeNull();
    expect(
      parseGovernedLogCitationId("log_event:18446744073709551616"),
    ).toBeNull();
    expect(parseGovernedLogCitationId("log_event:abc")).toBeNull();
    expect(parseLogEventSeq("log_event:abc")).toBeNull();
    expect(parseLogTemplateId("log_template:x")).toBeNull();
  });
});

describe("classifyCompletedCitation (#701)", () => {
  it("classifies Help, log, file, deferred, and invalid schemes", () => {
    expect(classifyCompletedCitation("help://log-explorer#lanes")).toBe(
      "help",
    );
    // Only canonical u64 form is "log"; legacy alphanumeric forms fail closed.
    expect(classifyCompletedCitation("log_template:template-17")).toBe(
      "invalid",
    );
    expect(classifyCompletedCitation("log_event:event_42")).toBe("invalid");
    expect(classifyCompletedCitation("log_event:42")).toBe("log");
    expect(classifyCompletedCitation("log_template:7")).toBe("log");
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

  it("parses numeric log identities for Explorer reveal only when safe", () => {
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
    const ok = await openPersistedLogCitation(
      "log_template:7",
      undefined,
      unavailable,
      open,
    );
    expect(ok).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalled();
  });

  it("returns false when host exact-nav fails (callers must not claim success)", async () => {
    const open = vi.fn();
    const openTarget = vi.fn().mockRejectedValue(new Error("corpus discarded"));
    const unavailable = vi.fn();
    const ok = await openPersistedLogCitation(
      "log_event:42",
      "gone-corpus",
      unavailable,
      open,
      openTarget,
    );
    expect(ok).toBe(false);
    expect(open).not.toHaveBeenCalled();
    expect(openTarget).toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledWith(
      "log_event:42",
      expect.stringMatching(/unavailable[\s\S]*discarded/i),
    );
  });

  it("returns true only when host exact-nav succeeds", async () => {
    const open = vi.fn();
    const openTarget = vi.fn().mockResolvedValue({ windowLabel: "x" });
    const unavailable = vi.fn();
    const ok = await openPersistedLogCitation(
      "log_event:42",
      "c1",
      unavailable,
      open,
      openTarget,
    );
    expect(ok).toBe(true);
    expect(unavailable).not.toHaveBeenCalled();
  });
});
