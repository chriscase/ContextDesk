import { createHmac, randomBytes } from "node:crypto";
import { link, mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const PUBLIC_IDENTITY_KEY_FILE = "public-identity-key";
const PUBLIC_IDENTITY_KEY_BYTES = 32;
const PUBLIC_ID_RE = /^usr-[a-f0-9]{32}$/;
const PUBLIC_IDENTITY_FIELDS = new Set([
  "actorId",
  "authorId",
  "createdBy",
  "id",
  "identityId",
  "ownerId",
  "promotedById",
  "requestedBy",
  "reviewerId",
  "sourceActorId",
  "uploaderId",
]);
const CASE_IGNORE_DN_ATTRIBUTES = new Set([
  "c",
  "cn",
  "dc",
  "employeenumber",
  "givenname",
  "l",
  "o",
  "ou",
  "serialnumber",
  "sn",
  "st",
  "street",
  "uid",
]);
const COMMON_DN_ATTRIBUTE = String.raw`(?:c|cn|dc|employeenumber|givenname|l|o|ou|serialnumber|sn|st|street|uid)`;
const DN_ATTRIBUTE = String.raw`(?:[a-z][a-z0-9-]*|\d+(?:\.\d+)+)`;
// Keep this expression deterministic: values never consume a component comma.
// Ambiguous escaped/multi-valued syntax is detected separately and rejected.
const DN_COMPONENT = String.raw`${DN_ATTRIBUTE}\s*=\s*[^,\r\n"{}]+`;
const WHOLE_DN_RE = new RegExp(String.raw`^\s*${DN_COMPONENT}(?:\s*,\s*${DN_COMPONENT})+\s*$`, "i");
const EMBEDDED_DN_RE = new RegExp(String.raw`${DN_COMPONENT}(?:\s*,\s*${DN_COMPONENT})+`, "gi");
const AMBIGUOUS_DN_SEQUENCE_RE = new RegExp(
  String.raw`${COMMON_DN_ATTRIBUTE}\s*=\s*(?:["#]|[^,\r\n]*[\\+<>;])[^\r\n]{0,512},\s*${COMMON_DN_ATTRIBUTE}\s*=`,
  "i",
);

export interface PublicIdentityCodec {
  publicId(raw: string): string;
  sanitizePayload<T>(value: T): T;
  sanitizeText(value: string): string;
  containsDirectoryDn(value: string): boolean;
}

function parseKey(raw: string | Buffer): Buffer {
  const bytes = Buffer.isBuffer(raw) ? Buffer.from(raw) : Buffer.from(raw.trim(), "base64url");
  if (bytes.byteLength !== PUBLIC_IDENTITY_KEY_BYTES) {
    throw new Error("public identity key must be exactly 32 bytes");
  }
  return bytes;
}

function componentAttributes(raw: string): string[] {
  return raw.split(",").flatMap((component) => {
    const equals = component.indexOf("=");
    return equals <= 0
      ? []
      : [component.slice(0, equals).trim().toLocaleLowerCase("en-US")];
  });
}

function looksLikeDirectoryDn(raw: string): boolean {
  return WHOLE_DN_RE.test(raw)
    && componentAttributes(raw).some((attribute) => CASE_IGNORE_DN_ATTRIBUTES.has(attribute));
}

function hasAmbiguousDirectoryDn(raw: string): boolean {
  return AMBIGUOUS_DN_SEQUENCE_RE.test(raw);
}

function canonicalizeDirectoryDn(raw: string): string | null {
  if (hasAmbiguousDirectoryDn(raw)) {
    throw new Error("directory DN cannot be safely canonicalized");
  }
  if (!looksLikeDirectoryDn(raw)) return null;
  const components = raw.split(",").map((component) => {
    const equals = component.indexOf("=");
    if (equals <= 0) throw new Error("directory DN cannot be safely canonicalized");
    const attribute = component.slice(0, equals).trim().toLocaleLowerCase("en-US");
    const value = component.slice(equals + 1).trim();
    if (!CASE_IGNORE_DN_ATTRIBUTES.has(attribute) || value.length === 0 || value.includes("=")) {
      throw new Error("directory DN cannot be safely canonicalized");
    }
    const canonicalValue = value
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .toLocaleLowerCase("en-US");
    return `${attribute}=${canonicalValue}`;
  });
  return components.join(",");
}

export class HmacPublicIdentityCodec implements PublicIdentityCodec {
  private readonly key: Buffer;

  constructor(key: string | Buffer) {
    this.key = parseKey(key);
  }

  publicId(raw: string): string {
    if (PUBLIC_ID_RE.test(raw)) return raw;
    const canonical = canonicalizeDirectoryDn(raw);
    if (canonical === null) {
      if (WHOLE_DN_RE.test(raw)) {
        throw new Error("directory DN cannot be safely canonicalized");
      }
      return raw;
    }
    const digest = createHmac("sha256", this.key)
      .update("contextdesk.public-identity.v1\0", "utf8")
      .update(canonical, "utf8")
      .digest("hex")
      .slice(0, 32);
    return `usr-${digest}`;
  }

  containsDirectoryDn(value: string): boolean {
    if (hasAmbiguousDirectoryDn(value)) return true;
    if (looksLikeDirectoryDn(value)) return true;
    EMBEDDED_DN_RE.lastIndex = 0;
    for (const match of value.matchAll(EMBEDDED_DN_RE)) {
      if (looksLikeDirectoryDn(match[0])) return true;
    }
    return false;
  }

  sanitizeText(value: string): string {
    if (hasAmbiguousDirectoryDn(value)) {
      throw new Error("directory DN cannot be safely canonicalized");
    }
    if (PUBLIC_ID_RE.test(value)) return value;
    if (looksLikeDirectoryDn(value)) return this.publicId(value);
    EMBEDDED_DN_RE.lastIndex = 0;
    return value.replace(EMBEDDED_DN_RE, (subject) => (
      looksLikeDirectoryDn(subject) ? this.publicId(subject) : subject
    ));
  }

  sanitizePayload<T>(value: T): T {
    return sanitizeValue(value, this) as T;
  }
}

function sanitizeValue(value: unknown, codec: PublicIdentityCodec, field?: string): unknown {
  if (typeof value === "string") {
    return field && PUBLIC_IDENTITY_FIELDS.has(field)
      ? codec.publicId(value)
      : codec.sanitizeText(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, codec, field));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    out[codec.sanitizeText(key)] = sanitizeValue(item, codec, key);
  }
  return out;
}

export function createEphemeralPublicIdentityCodec(): HmacPublicIdentityCodec {
  return new HmacPublicIdentityCodec(randomBytes(PUBLIC_IDENTITY_KEY_BYTES));
}

async function readPrivateKey(path: string): Promise<Buffer> {
  const metadata = await stat(path);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error("public identity key permissions must deny group and other access");
  }
  return readFile(path);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Load the durable installation-local key used only for public user ids. */
export async function loadPublicIdentityCodec(
  evidenceRoot: string,
  configured?: string,
): Promise<HmacPublicIdentityCodec> {
  if (configured?.trim()) return new HmacPublicIdentityCodec(configured);
  await mkdir(evidenceRoot, { recursive: true });
  const path = join(evidenceRoot, PUBLIC_IDENTITY_KEY_FILE);
  try {
    return new HmacPublicIdentityCodec(await readPrivateKey(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Stage and flush the bytes before exclusive publication. A hard link becomes
  // visible atomically, so an EEXIST observer can never read a partially written key.
  const generated = randomBytes(PUBLIC_IDENTITY_KEY_BYTES);
  const temporaryPath = join(
    evidenceRoot,
    `.${PUBLIC_IDENTITY_KEY_FILE}.${process.pid}.${randomBytes(16).toString("hex")}.tmp`,
  );
  const temporary = await open(temporaryPath, "wx", 0o600);
  let published = false;
  try {
    try {
      await temporary.writeFile(generated);
      await temporary.sync();
    } finally {
      await temporary.close();
    }
    try {
      await link(temporaryPath, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await unlink(temporaryPath);
  }
  await syncDirectory(evidenceRoot);
  return published
    ? new HmacPublicIdentityCodec(generated)
    : new HmacPublicIdentityCodec(await readPrivateKey(path));
}
