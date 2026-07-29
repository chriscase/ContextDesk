import { describe, expect, it } from "vitest";
import type { LogCorpusSummaryDto } from "./host";
import {
  buildLogDiagnosticReport,
  LOG_DIAGNOSTIC_NOTE_MAX_CHARS,
  LOG_DIAGNOSTIC_REPORT_MAX_BYTES,
} from "./logDiagnosticReport";

function privateCorpus(): LogCorpusSummaryDto {
  return {
    id: "019fab76-18ff-7361-8dd8-e4ddc0f1bb6c",
    name: "Incident at private.internal with sk-abcdefghijk",
    eventCount: 25_000,
    templateCount: 412,
    engine: "duckdb",
    createdAt: 1_753_680_000,
    sourceLabel: "/Users/chris/Company/private-incident.log",
    stats: {
      files: 7,
      discoveredFiles: 10,
      excludedFiles: 1,
      failedFiles: 1,
      ignoredFiles: 1,
      exclusionCounts: {
        binary: 1,
        open_failed: 1,
        hidden: 1,
      },
      exclusionExamples: [
        "binary: /Users/chris/Company/core.bin",
        "open_failed: C:\\Company\\secret.log",
        "hidden: /home/engineer/.ignored.log",
      ],
      partial: true,
      lines: 25_000,
      templates: 412,
      reductionRatio: 60.7,
      embedded: 0,
      sourceBytes: 16_367_576,
      corpusBytes: 22_000_000,
      levelCounts: { info: 24_000, error: 1_000 },
      tsMin: 1_735_689_600,
      tsMax: 1_735_776_000,
      formatCounts: { json: 20_000, logfmt: 5_000 },
    },
    topTemplates: [
      {
        id: 1,
        pattern: "TOP_TEMPLATE_PRIVATE_PAYLOAD customer=secret",
        count: 1_000,
        severity: 5,
      },
    ],
    embedding: {
      state: "partial",
      modelId: "embarrassing-private-model",
      embeddedTemplates: 100,
      totalTemplates: 412,
      reason: "private-provider-reason",
      updatedAt: 1_753_680_100,
    },
  };
}

describe("buildLogDiagnosticReport", () => {
  it("exports only allowlisted corpus diagnostics and basename-only examples", () => {
    const report = buildLogDiagnosticReport({
      corpus: privateCorpus(),
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: "de43caeba66df05068a50db9356efad3b64a4a45",
        os: "macOS",
      },
      currentStatus: {
        kind: "error",
        message:
          "failed at /Users/chris/Company/private.log from 10.4.3.2 Bearer super-secret-token",
      },
      userNote:
        "Repro under /home/chris/work against private.internal using ghp_abcdefghijklmnopqrstuvwxyz",
      generatedAt: new Date("2026-07-28T12:00:00.000Z"),
    });

    expect(report.manifest.corpus.stats?.basenameExamples).toEqual([
      "binary: core.bin",
      "open_failed: secret.log",
      "hidden: .ignored.log",
    ]);
    expect(report.manifest.corpus.embedding).toEqual({ state: "partial" });
    expect(report.markdown).toContain("25,000".replace(",", ""));
    expect(report.markdown).toContain("json: 20000");
    expect(report.markdown).toContain("raw logs and event payloads");
    expect(report.json).toContain('"reviewRequired": true');

    const exported = `${report.markdown}\n${report.json}`;
    for (const forbidden of [
      "/Users/chris",
      "/home/chris",
      "C:\\Company",
      "10.4.3.2",
      "private.internal",
      "super-secret-token",
      "ghp_abcdefghijklmnopqrstuvwxyz",
      "TOP_TEMPLATE_PRIVATE_PAYLOAD",
      "private-incident.log",
      "embarrassing-private-model",
      "private-provider-reason",
    ]) {
      expect(exported).not.toContain(forbidden);
    }
  });

  it("caps notes, count maps, examples, status, and total serialized size", () => {
    const corpus = privateCorpus();
    if (!corpus.stats) throw new Error("fixture stats missing");
    corpus.stats.exclusionExamples = Array.from(
      { length: 100 },
      (_, index) => `reason_${index}: /Users/private/file-${index}.log`,
    );
    corpus.stats.levelCounts = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`level_${index}`, index + 1]),
    );

    const report = buildLogDiagnosticReport({
      corpus,
      environment: {
        appVersion: "0.1.0",
        channel: "dev",
        gitSha: null,
        os: "Linux",
      },
      currentStatus: { kind: "status", message: "s".repeat(10_000) },
      userNote: "n".repeat(10_000),
    });

    expect(Array.from(report.manifest.userNote ?? "")).toHaveLength(
      LOG_DIAGNOSTIC_NOTE_MAX_CHARS,
    );
    expect(report.manifest.currentStatus?.message.length).toBe(800);
    expect(
      report.manifest.corpus.stats?.basenameExamples,
    ).toHaveLength(12);
    expect(
      Object.keys(report.manifest.corpus.stats?.levelCounts ?? {}),
    ).toHaveLength(32);
    expect(new TextEncoder().encode(report.markdown).length).toBeLessThanOrEqual(
      LOG_DIAGNOSTIC_REPORT_MAX_BYTES,
    );
    expect(new TextEncoder().encode(report.json).length).toBeLessThanOrEqual(
      LOG_DIAGNOSTIC_REPORT_MAX_BYTES,
    );
  });

  it("does not infer timestamp quality from stored scalar bounds", () => {
    const report = buildLogDiagnosticReport({
      corpus: privateCorpus(),
      environment: {
        appVersion: "0.1.0",
        channel: "installed",
        gitSha: null,
        os: "Windows",
      },
    });

    expect(report.manifest.corpus.stats?.timeQuality).toBe(
      "not_persisted_in_corpus_summary",
    );
    expect(report.markdown).not.toContain("wall clock");
  });
});
