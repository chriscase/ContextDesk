/**
 * Private, provider-owned evidence namespace identity.
 *
 * This module is deliberately pure. Reading or creating the manifest belongs
 * to the provider adapters; importing or parsing this contract performs no I/O.
 */

export const EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID =
  "cd-collab.evidence_provider_instance.v1" as const;
export const MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES = 512;

export type EvidenceProviderInstanceKind = "filesystem" | "s3";

export interface EvidenceProviderInstanceV1 {
  readonly schemaId: typeof EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID;
  readonly providerInstanceId: string;
  readonly providerKind: EvidenceProviderInstanceKind;
}

export type EvidenceProviderInstanceErrorCode =
  | "too_large"
  | "invalid_utf8"
  | "bom"
  | "duplicate_key"
  | "invalid_json"
  | "trailing_data"
  | "invalid_shape"
  | "unknown_field"
  | "missing_field"
  | "invalid_schema"
  | "invalid_id"
  | "invalid_provider";

export class EvidenceProviderInstanceError extends Error {
  readonly code: EvidenceProviderInstanceErrorCode;

  constructor(code: EvidenceProviderInstanceErrorCode) {
    super("evidence provider instance manifest is invalid");
    this.name = "EvidenceProviderInstanceError";
    this.code = code;
  }
}

const PROVIDER_INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const EXPECTED_KEYS = new Set(["schemaId", "providerInstanceId", "providerKind"]);

export function isCanonicalEvidenceProviderInstanceId(value: string): boolean {
  return PROVIDER_INSTANCE_ID.test(value);
}

export function assertCanonicalEvidenceProviderInstanceId(value: unknown): string {
  if (typeof value !== "string" || !isCanonicalEvidenceProviderInstanceId(value)) {
    throw new EvidenceProviderInstanceError("invalid_id");
  }
  return value;
}

export function parseEvidenceProviderInstance(
  bytes: Uint8Array,
): EvidenceProviderInstanceV1 {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES) {
    throw new EvidenceProviderInstanceError("too_large");
  }
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new EvidenceProviderInstanceError("bom");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EvidenceProviderInstanceError("invalid_utf8");
  }
  scanJson(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new EvidenceProviderInstanceError("invalid_json");
  }
  return parseManifestValue(parsed);
}

export function serializeEvidenceProviderInstance(
  value: EvidenceProviderInstanceV1,
): Uint8Array {
  const manifest = parseManifestValue(value);
  const text =
    `{"schemaId":${JSON.stringify(EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID)}`
    + `,"providerInstanceId":${JSON.stringify(manifest.providerInstanceId)}`
    + `,"providerKind":${JSON.stringify(manifest.providerKind)}}`;
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_EVIDENCE_PROVIDER_INSTANCE_BYTES) {
    throw new EvidenceProviderInstanceError("too_large");
  }
  return bytes;
}

function parseManifestValue(value: unknown): EvidenceProviderInstanceV1 {
  try {
    return parseManifestValueUnsafe(value);
  } catch (error) {
    if (error instanceof EvidenceProviderInstanceError) throw error;
    throw new EvidenceProviderInstanceError("invalid_shape");
  }
}

function parseManifestValueUnsafe(value: unknown): EvidenceProviderInstanceV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new EvidenceProviderInstanceError("invalid_shape");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new EvidenceProviderInstanceError("invalid_shape");
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !EXPECTED_KEYS.has(key))) {
    throw new EvidenceProviderInstanceError("unknown_field");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new EvidenceProviderInstanceError("invalid_shape");
    }
  }
  for (const key of EXPECTED_KEYS) {
    if (!Object.hasOwn(descriptors, key)) {
      throw new EvidenceProviderInstanceError("missing_field");
    }
  }
  const schemaId = descriptors.schemaId?.value as unknown;
  const providerInstanceId = descriptors.providerInstanceId?.value as unknown;
  const providerKind = descriptors.providerKind?.value as unknown;
  if (schemaId !== EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID) {
    throw new EvidenceProviderInstanceError("invalid_schema");
  }
  const id = assertCanonicalEvidenceProviderInstanceId(providerInstanceId);
  if (providerKind !== "filesystem" && providerKind !== "s3") {
    throw new EvidenceProviderInstanceError("invalid_provider");
  }
  return Object.freeze({
    schemaId: EVIDENCE_PROVIDER_INSTANCE_SCHEMA_ID,
    providerInstanceId: id,
    providerKind,
  });
}

/** Detect duplicate JSON keys before JSON.parse applies its last-key-wins rule. */
function scanJson(text: string): void {
  const scanner = new JsonScanner(text);
  scanner.value(0);
  scanner.whitespace();
  if (!scanner.done()) scanner.fail("trailing_data");
}

class JsonScanner {
  private offset = 0;

  constructor(private readonly text: string) {}

  done(): boolean {
    return this.offset === this.text.length;
  }

  whitespace(): void {
    while (
      this.text[this.offset] === " "
      || this.text[this.offset] === "\t"
      || this.text[this.offset] === "\n"
      || this.text[this.offset] === "\r"
    ) {
      this.offset += 1;
    }
  }

  fail(code: EvidenceProviderInstanceErrorCode = "invalid_json"): never {
    throw new EvidenceProviderInstanceError(code);
  }

  value(depth: number): void {
    if (depth > 8) this.fail();
    this.whitespace();
    const char = this.text[this.offset];
    if (char === "{") return this.object(depth + 1);
    if (char === "[") return this.array(depth + 1);
    if (char === '"') {
      this.string();
      return;
    }
    for (const literal of ["true", "false", "null"] as const) {
      if (this.text.startsWith(literal, this.offset)) {
        this.offset += literal.length;
        return;
      }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/u.exec(
      this.text.slice(this.offset),
    );
    if (!match) this.fail();
    this.offset += match[0].length;
  }

  private object(depth: number): void {
    this.offset += 1;
    this.whitespace();
    if (this.text[this.offset] === "}") {
      this.offset += 1;
      return;
    }
    const keys = new Set<string>();
    while (true) {
      this.whitespace();
      if (this.text[this.offset] !== '"') this.fail();
      const key = this.string();
      if (keys.has(key)) this.fail("duplicate_key");
      keys.add(key);
      this.whitespace();
      if (this.text[this.offset] !== ":") this.fail();
      this.offset += 1;
      this.value(depth);
      this.whitespace();
      const char = this.text[this.offset];
      if (char === "}") {
        this.offset += 1;
        return;
      }
      if (char !== ",") this.fail();
      this.offset += 1;
    }
  }

  private array(depth: number): void {
    this.offset += 1;
    this.whitespace();
    if (this.text[this.offset] === "]") {
      this.offset += 1;
      return;
    }
    while (true) {
      this.value(depth);
      this.whitespace();
      const char = this.text[this.offset];
      if (char === "]") {
        this.offset += 1;
        return;
      }
      if (char !== ",") this.fail();
      this.offset += 1;
    }
  }

  private string(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const char = this.text[this.offset];
      if (char === '"') {
        this.offset += 1;
        try {
          return JSON.parse(this.text.slice(start, this.offset)) as string;
        } catch {
          this.fail();
        }
      }
      if ((char?.charCodeAt(0) ?? 0) < 0x20) this.fail();
      if (char === "\\") {
        this.offset += 1;
        const escaped = this.text[this.offset];
        if (escaped === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(this.text.slice(this.offset + 1, this.offset + 5))) {
            this.fail();
          }
          this.offset += 5;
          continue;
        }
        if (!escaped || !'"\\/bfnrt'.includes(escaped)) this.fail();
      }
      this.offset += 1;
    }
    this.fail();
  }
}
