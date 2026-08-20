import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  LAB_EXPORT_V2_SCHEMA_ID,
  parseLabExportV2,
  scanShareSafePrivacy,
} from "./index.js";

const Ajv2020 =
  (Ajv2020Import as unknown as { default?: unknown }).default ?? Ajv2020Import;
const addFormats =
  (addFormatsImport as unknown as { default?: unknown }).default ?? addFormatsImport;
const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, "..", "fixtures", "experiment-lab-export.v2.valid.json");
const schemaPath = join(here, "..", "schemas", "experiment-lab-export.v2.json");

function fixture(): Record<string, unknown> {
  return JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;
}

type PathPart = string | number;

function stringPaths(value: unknown, path: PathPart[] = [], out: PathPart[][] = []): PathPart[][] {
  if (typeof value === "string") {
    out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => stringPaths(item, [...path, index], out));
  } else if (value && typeof value === "object") {
    Object.entries(value as Record<string, unknown>).forEach(([key, child]) =>
      stringPaths(child, [...path, key], out),
    );
  }
  return out;
}

function objectPaths(value: unknown, path: PathPart[] = [], out: PathPart[][] = []): PathPart[][] {
  if (!value || typeof value !== "object") return out;
  if (!Array.isArray(value)) out.push(path);
  Object.entries(value).forEach(([key, child]) =>
    objectPaths(child, [...path, Array.isArray(value) ? Number(key) : key], out),
  );
  return out;
}

function atPath(root: unknown, path: PathPart[]): unknown {
  return path.reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object") throw new Error("invalid mutation path");
    return (value as Record<PathPart, unknown>)[part];
  }, root);
}

function replaceAtPath(root: unknown, path: PathPart[], value: unknown): void {
  const parent = atPath(root, path.slice(0, -1));
  const last = path.at(-1);
  if (!parent || typeof parent !== "object" || last === undefined) {
    throw new Error("invalid mutation path");
  }
  (parent as Record<PathPart, unknown>)[last] = value;
}

describe("Experiment Lab share-safe export v2 privacy boundary", () => {
  it("parses the synthetic export while preserving structure, scores, aliases, hashes, and gold", () => {
    const parsed = parseLabExportV2(fixture());
    expect(parsed.schemaId).toBe(LAB_EXPORT_V2_SCHEMA_ID);
    expect(parsed.review.observations[0]?.score).toBe(3);
    expect(parsed.review.decision?.status).toBe("accepted");
    expect(parsed.review.gold?.version).toBe(1);
    expect(parsed.review.candidates[0]?.goldState).toBe("present");
    expect(parsed.review.agreement.sharedAnchors[0]?.evidenceAlias).toBe("evidence-1");
    expect(parsed.review.taskAlias).toBe("task-1");
    expect(parsed.review.snapshotAlias).toBe("snapshot-1");
    expect(parsed.review.candidates[0]?.observedLatency).toEqual({ status: "unknown" });
    expect(parsed.traces[0]?.efficiency.latency).toEqual({ status: "unknown" });
    expect(parsed.traces[0]?.unknowns).toEqual(["tools"]);
    expect(parsed.comparison.gold.status).toBe("present");
    expect(scanShareSafePrivacy(parsed)).toEqual([]);

    const encoded = JSON.stringify(parsed);
    for (const forbidden of [
      '"modelLabel":',
      '"reviewerUsername":',
      '"authorUsername":',
      '"promotedByUsername":',
      '"rationale"',
      '"text"',
      '"excerpt"',
      '"notes"',
      '"summary"',
      '"taskFingerprint"',
      '"snapshotFingerprint"',
      '"rawHash"',
      '"excerptHash"',
      '"createdAt"',
      '"observedAt"',
      '"milliseconds"',
    ]) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it("matches the strict v2 JSON schema and rejects contract drift", () => {
    const AjvCtor = Ajv2020 as new (opts: {
      allErrors: boolean;
      strict: boolean;
    }) => { compile: (schema: object) => (data: unknown) => boolean };
    const ajv = new AjvCtor({ allErrors: true, strict: true });
    (addFormats as (instance: unknown) => void)(ajv);
    const validate = ajv.compile(
      JSON.parse(readFileSync(schemaPath, "utf8")) as object,
    );
    expect(validate(fixture())).toBe(true);
    expect(validate({ ...fixture(), modelLabel: "private-model" })).toBe(false);
    expect(() => parseLabExportV2({ ...fixture(), harmlessExtra: true })).toThrow(/unknown key/);
  });

  it("rejects every adversarial class at every string-bearing leaf", () => {
    const threats = [
      "https://public.example/export",
      "mailto:ops@example.com",
      "db01.internal.example.com",
      "localhost",
      "/Users/alice/employer/report.txt",
      "C:\\Users\\Alice\\employer\\report.txt",
      "Bearer employer-secret-value",
      "request_id=req-private-123456",
    ];
    const paths = stringPaths(fixture());
    expect(paths.length).toBeGreaterThan(50);
    for (const path of paths) {
      for (const threat of threats) {
        const mutated = structuredClone(fixture());
        replaceAtPath(mutated, path, threat);
        expect(
          () => parseLabExportV2(mutated),
          `expected ${threat} at ${path.join(".")} to fail closed`,
        ).toThrow(/share-safe privacy gate rejected/);
      }
    }
  });

  it("rejects forbidden request, credential, endpoint, prompt, and capture keys at every object", () => {
    const forbiddenKeys = [
      "rawModelCapture",
      "raw_capture",
      "requestId",
      "x-request-id",
      "apiKey",
      "authorization",
      "endpoint",
      "baseUrl",
      "prompt",
    ];
    const paths = objectPaths(fixture());
    expect(paths.length).toBeGreaterThan(25);
    for (const path of paths) {
      for (const key of forbiddenKeys) {
        const mutated = structuredClone(fixture());
        const target = atPath(mutated, path) as Record<string, unknown>;
        target[key] = "synthetic-private-value";
        expect(
          () => parseLabExportV2(mutated),
          `expected ${key} at ${path.join(".")} to fail closed`,
        ).toThrow(/share-safe privacy gate rejected/);
      }
    }
  });

  it("keeps runtime caveat cardinality aligned with the published schema", () => {
    for (const path of [
      ["review", "caveats"],
      ["traces", 0, "caveats"],
      ["comparison", "caveats"],
    ] satisfies PathPart[][]) {
      const duplicated = structuredClone(fixture());
      const caveats = atPath(duplicated, path) as string[];
      caveats.push(caveats[0] ?? "agreement_not_correctness");
      expect(() => parseLabExportV2(duplicated)).toThrow(
        /expected each required caveat exactly once/,
      );
    }
  });
});
