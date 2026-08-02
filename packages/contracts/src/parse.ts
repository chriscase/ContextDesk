/**
 * Dependency-free strict runtime validation for `cd.v1` wire values.
 *
 * These validators are contract-drift detectors, not permissive runtime
 * guards: they reject unknown keys, wrong casing, wrong primitive types,
 * integers outside JavaScript's safe range, out-of-set enum values, and
 * null/absent confusion (a serde `Option` without `skip_serializing_if`
 * is always present-and-nullable; a skipped `Option` may be absent but is
 * never null). Type assertions alone prove nothing — every fixture byte
 * runs through these checks in the package tests.
 */

export class ContractViolation extends Error {
  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "ContractViolation";
  }
}

/**
 * Field presence semantics mirroring serde:
 * - `required`  — key present, value non-null.
 * - `nullable`  — key present, value may be null (`Option` without skip).
 * - `optional`  — key may be absent; when present, non-null (`Option` with
 *                 `skip_serializing_if = "Option::is_none"`, or skipped-empty
 *                 collections).
 */
export type FieldMode = "required" | "nullable" | "optional";

export type FieldType =
  | { kind: "string" }
  | { kind: "bool" }
  /** Unsigned integer that must be a safe JS integer (u64/u32/usize/u8). */
  | { kind: "u64" }
  /** Signed integer that must be a safe JS integer (i64/i32). */
  | { kind: "i64" }
  /** Finite number in 0..=1 (serde `f32` completion fraction). */
  | { kind: "unitFraction" }
  | { kind: "enum"; values: readonly string[] }
  /** Any JSON value (e.g. `serde_json::Value` payloads). */
  | { kind: "json" }
  /**
   * A closed vocabulary too shaped for `enum` — an externally-tagged Rust enum
   * whose variants mix bare strings and single-key objects. `json` would accept
   * anything, which is exactly what a closed vocabulary must not do.
   */
  | { kind: "predicate"; name: string; test: (value: unknown) => boolean }
  | { kind: "array"; of: FieldType }
  /** Object with arbitrary string keys and uniformly typed values. */
  | { kind: "map"; value: FieldType }
  | { kind: "object"; shape: ObjectShape };

export type ObjectShape = Readonly<
  Record<string, { mode: FieldMode; type: FieldType }>
>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function checkValue(path: string, type: FieldType, v: unknown): void {
  switch (type.kind) {
    case "string":
      if (typeof v !== "string")
        throw new ContractViolation(path, `expected string, got ${describe(v)}`);
      return;
    case "bool":
      if (typeof v !== "boolean")
        throw new ContractViolation(path, `expected boolean, got ${describe(v)}`);
      return;
    case "u64":
      if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0)
        throw new ContractViolation(
          path,
          `expected unsigned safe integer, got ${describe(v)}`,
        );
      return;
    case "i64":
      if (typeof v !== "number" || !Number.isSafeInteger(v))
        throw new ContractViolation(
          path,
          `expected signed safe integer, got ${describe(v)}`,
        );
      return;
    case "unitFraction":
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        v < 0 ||
        v > 1
      )
        throw new ContractViolation(
          path,
          `expected fraction in 0..=1, got ${describe(v)}`,
        );
      return;
    case "enum":
      if (typeof v !== "string" || !type.values.includes(v))
        throw new ContractViolation(
          path,
          `expected one of [${type.values.join(", ")}], got ${describe(v)}`,
        );
      return;
    case "json":
      if (v === undefined)
        throw new ContractViolation(path, "expected a JSON value, got undefined");
      return;
    case "predicate":
      if (!type.test(v))
        throw new ContractViolation(path, `expected ${type.name}, got ${describe(v)}`);
      return;
    case "array": {
      if (!Array.isArray(v))
        throw new ContractViolation(path, `expected array, got ${describe(v)}`);
      v.forEach((item, i) => checkValue(`${path}[${i}]`, type.of, item));
      return;
    }
    case "map": {
      if (!isPlainObject(v))
        throw new ContractViolation(path, `expected object map, got ${describe(v)}`);
      for (const [key, item] of Object.entries(v)) {
        checkValue(`${path}.${key}`, type.value, item);
      }
      return;
    }
    case "object":
      checkObject(path, type.shape, v);
      return;
  }
}

export function checkObject(
  path: string,
  shape: ObjectShape,
  v: unknown,
): void {
  if (!isPlainObject(v))
    throw new ContractViolation(path, `expected object, got ${describe(v)}`);
  for (const key of Object.keys(v)) {
    if (!(key in shape))
      throw new ContractViolation(`${path}.${key}`, "unknown key (contract drift)");
  }
  for (const [key, spec] of Object.entries(shape)) {
    const present = key in v;
    const value = (v as Record<string, unknown>)[key];
    const fieldPath = `${path}.${key}`;
    if (!present) {
      if (spec.mode === "optional") continue;
      throw new ContractViolation(fieldPath, "missing required key");
    }
    if (value === null) {
      if (spec.mode === "nullable") continue;
      throw new ContractViolation(
        fieldPath,
        spec.mode === "optional"
          ? "skipped-optional field must be absent, never null"
          : "unexpected null",
      );
    }
    checkValue(fieldPath, spec.type, value);
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number" && !Number.isSafeInteger(v) && Number.isInteger(v))
    return `unsafe integer ${v}`;
  return typeof v === "object" ? "object" : `${typeof v} ${JSON.stringify(v)}`;
}

/** Shorthand builders keeping family shape tables readable. */
export const f = {
  req: (type: FieldType) => ({ mode: "required" as const, type }),
  nul: (type: FieldType) => ({ mode: "nullable" as const, type }),
  opt: (type: FieldType) => ({ mode: "optional" as const, type }),
  str: { kind: "string" } as FieldType,
  bool: { kind: "bool" } as FieldType,
  u64: { kind: "u64" } as FieldType,
  i64: { kind: "i64" } as FieldType,
  unit: { kind: "unitFraction" } as FieldType,
  json: { kind: "json" } as FieldType,
  pred: (name: string, test: (value: unknown) => boolean): FieldType => ({
    kind: "predicate",
    name,
    test,
  }),
  en: (...values: string[]): FieldType => ({ kind: "enum", values }),
  arr: (of: FieldType): FieldType => ({ kind: "array", of }),
  map: (value: FieldType): FieldType => ({ kind: "map", value }),
  obj: (shape: ObjectShape): FieldType => ({ kind: "object", shape }),
};
