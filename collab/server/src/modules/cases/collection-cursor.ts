/**
 * Server-owned collection-page cursor.
 *
 * The browser contract treats the token as opaque. This module mints and
 * verifies it so a cursor cannot be replayed across actors, authorization,
 * or a different query. Malformed and mismatched tokens fail closed.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ContractViolation, canonicalJson } from "@cd-collab/contracts";

const CURSOR_VERSION = 1 as const;
const CURSOR_PURPOSE = "cd-collab.investigation_collection_cursor.v1";
const OPAQUE_CURSOR_RE = /^[A-Za-z0-9_-]{8,4096}$/;
const HMAC_KEY = randomBytes(32);

export interface InvestigationCollectionCursor {
  actorId: string;
  isAdmin: boolean;
  queryFingerprint: string;
  createdAt: string;
  id: string;
}

export class CollectionCursorError extends Error {
  constructor(readonly code: "malformed_cursor" | "stale_cursor") {
    super(code);
    this.name = "CollectionCursorError";
  }
}

function unsignedBody(cursor: InvestigationCollectionCursor): string {
  return canonicalJson({
    v: CURSOR_VERSION,
    a: cursor.actorId,
    g: cursor.isAdmin ? 1 : 0,
    q: cursor.queryFingerprint,
    t: cursor.createdAt,
    i: cursor.id,
  });
}

function macOf(body: string): string {
  return createHmac("sha256", HMAC_KEY).update(CURSOR_PURPOSE).update(body).digest("base64url");
}

function equalMac(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

export function mintInvestigationCollectionCursor(
  cursor: InvestigationCollectionCursor,
): string {
  const body = unsignedBody(cursor);
  const token = Buffer.from(
    canonicalJson({
      v: CURSOR_VERSION,
      a: cursor.actorId,
      g: cursor.isAdmin ? 1 : 0,
      q: cursor.queryFingerprint,
      t: cursor.createdAt,
      i: cursor.id,
      m: macOf(body),
    }),
    "utf8",
  ).toString("base64url");
  if (!OPAQUE_CURSOR_RE.test(token)) {
    throw new CollectionCursorError("malformed_cursor");
  }
  return token;
}

export function parseInvestigationCollectionCursor(raw: string): InvestigationCollectionCursor {
  if (!OPAQUE_CURSOR_RE.test(raw)) {
    throw new CollectionCursorError("malformed_cursor");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new CollectionCursorError("malformed_cursor");
  }
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new CollectionCursorError("malformed_cursor");
  }
  const record = decoded as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 7
    || record.v !== CURSOR_VERSION
    || typeof record.a !== "string"
    || record.a.length < 1
    || (record.g !== 0 && record.g !== 1)
    || typeof record.q !== "string"
    || record.q.length !== 64
    || typeof record.t !== "string"
    || record.t.length < 1
    || typeof record.i !== "string"
    || record.i.length < 1
    || typeof record.m !== "string"
  ) {
    throw new CollectionCursorError("malformed_cursor");
  }
  const cursor: InvestigationCollectionCursor = {
    actorId: record.a,
    isAdmin: record.g === 1,
    queryFingerprint: record.q,
    createdAt: record.t,
    id: record.i,
  };
  if (!equalMac(record.m, macOf(unsignedBody(cursor)))) {
    throw new CollectionCursorError("malformed_cursor");
  }
  try {
    const roundTrip = mintInvestigationCollectionCursor(cursor);
    if (roundTrip !== raw) throw new ContractViolation("$", "malformed cursor");
  } catch (error) {
    if (error instanceof CollectionCursorError) throw error;
    throw new CollectionCursorError("malformed_cursor");
  }
  return cursor;
}
