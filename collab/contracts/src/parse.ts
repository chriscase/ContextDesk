/**
 * Strict runtime validation for collab contracts.
 * Rejects unknown keys (contract drift), wrong types, and null/absent confusion.
 */

export class ContractViolation extends Error {
  constructor(
    readonly path: string,
    readonly detail: string,
  ) {
    super(`${path}: ${detail}`);
    this.name = "ContractViolation";
  }
}

export type FieldMode = "required" | "nullable" | "optional";

export type FieldType =
  | { kind: "string" }
  | { kind: "bool" }
  | { kind: "u64" }
  | { kind: "enum"; values: readonly string[] }
  | { kind: "object"; shape: ObjectShape };

export type ObjectShape = Readonly<
  Record<string, { mode: FieldMode; type: FieldType }>
>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v === "object" ? "object" : `${typeof v} ${JSON.stringify(v)}`;
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
    case "enum":
      if (typeof v !== "string" || !type.values.includes(v))
        throw new ContractViolation(
          path,
          `expected one of [${type.values.join(", ")}], got ${describe(v)}`,
        );
      return;
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
    const value = v[key];
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

export const f = {
  req: (type: FieldType) => ({ mode: "required" as const, type }),
  nul: (type: FieldType) => ({ mode: "nullable" as const, type }),
  opt: (type: FieldType) => ({ mode: "optional" as const, type }),
  str: { kind: "string" } as FieldType,
  bool: { kind: "bool" } as FieldType,
  u64: { kind: "u64" } as FieldType,
  en: (...values: string[]): FieldType => ({ kind: "enum", values }),
  obj: (shape: ObjectShape): FieldType => ({ kind: "object", shape }),
};
