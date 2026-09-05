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
const COLLECTION_CURSOR_PURPOSE = "cd-collab.investigation_collection_cursor.v1";
const OPERATIONS_QUEUE_CURSOR_PURPOSE =
  "cd-collab.investigation_operations_queue_cursor.v1";
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

function macOf(body: string, purpose: string): string {
  return createHmac("sha256", HMAC_KEY).update(purpose).update(body).digest("base64url");
}

function equalMac(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function mintCursor(cursor: InvestigationCollectionCursor, purpose: string): string {
  const body = unsignedBody(cursor);
  const token = Buffer.from(
    canonicalJson({
      v: CURSOR_VERSION,
      a: cursor.actorId,
      g: cursor.isAdmin ? 1 : 0,
      q: cursor.queryFingerprint,
      t: cursor.createdAt,
      i: cursor.id,
      m: macOf(body, purpose),
    }),
    "utf8",
  ).toString("base64url");
  if (!OPAQUE_CURSOR_RE.test(token)) {
    throw new CollectionCursorError("malformed_cursor");
  }
  return token;
}

function parseCursor(raw: string, purpose: string): InvestigationCollectionCursor {
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
  if (!equalMac(record.m, macOf(unsignedBody(cursor), purpose))) {
    throw new CollectionCursorError("malformed_cursor");
  }
  try {
    const roundTrip = mintCursor(cursor, purpose);
    if (roundTrip !== raw) throw new ContractViolation("$", "malformed cursor");
  } catch (error) {
    if (error instanceof CollectionCursorError) throw error;
    throw new CollectionCursorError("malformed_cursor");
  }
  return cursor;
}

export function mintInvestigationCollectionCursor(
  cursor: InvestigationCollectionCursor,
): string {
  return mintCursor(cursor, COLLECTION_CURSOR_PURPOSE);
}

export function parseInvestigationCollectionCursor(raw: string): InvestigationCollectionCursor {
  return parseCursor(raw, COLLECTION_CURSOR_PURPOSE);
}

export function mintInvestigationOperationsQueueCursor(
  cursor: InvestigationCollectionCursor,
): string {
  return mintCursor(cursor, OPERATIONS_QUEUE_CURSOR_PURPOSE);
}

export function parseInvestigationOperationsQueueCursor(
  raw: string,
): InvestigationCollectionCursor {
  return parseCursor(raw, OPERATIONS_QUEUE_CURSOR_PURPOSE);
}
