/**
 * Synthetic fixture builders for the War Room scenario journeys.
 *
 * Nothing here is captured from a real system. The logs, the correspondence,
 * and the archive layout are all authored for these tests, using `example.test`
 * names and RFC 5737 documentation addresses, so the corpus stays reviewable
 * and safe to publish alongside the code.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syntheticZip } from "../synthetic-zip.js";

const here = dirname(fileURLToPath(import.meta.url));
const WAR_ROOM_FIXTURES = join(here, "..", "..", "fixtures", "war-room");

export type WarRoomFixtureName =
  | "mailer-offsetless.log"
  | "deploy-utc.log"
  | "customer-email-chain.eml"
  | "pasted-external-chat.txt"
  | "late-arriving-worker.log"
  | "postmortem-march-window.log";

export function warRoomText(name: WarRoomFixtureName): string {
  return readFileSync(join(WAR_ROOM_FIXTURES, name), "utf8");
}

export function warRoomBytes(name: WarRoomFixtureName): Buffer {
  return readFileSync(join(WAR_ROOM_FIXTURES, name));
}

/** One entry the noisy bundle is expected to accept, with why it is readable. */
export interface ExpectedAcceptance {
  path: string;
  why: string;
}

/** One entry the noisy bundle is expected to refuse, with the stated reason. */
export interface ExpectedRejection {
  path: string;
  /** Reason id from `CORPUS_REJECTION_REASONS`, as the preview reports it. */
  reason: string;
  why: string;
}

/**
 * A support bundle as they actually arrive: readable logs mixed with a binary
 * blob, a file whose extension lies about its contents, a duplicate path, and a
 * nested archive. The point of the fixture is that a responder can see what the
 * intake refused and why, rather than discovering later that a file vanished.
 */
export const NOISY_BUNDLE_ACCEPTED: readonly ExpectedAcceptance[] = [
  {
    path: "bundle/mailer/mailer-offsetless.log",
    why: "readable UTF-8 log; the timestamps are ambiguous but the bytes are legible",
  },
  {
    path: "bundle/deploy/deploy-utc.log",
    why: "readable UTF-8 log with explicit offsets",
  },
  {
    path: "bundle/notes/collector-notes.md",
    why: "readable markdown written by whoever collected the bundle",
  },
] as const;

export const NOISY_BUNDLE_REJECTED: readonly ExpectedRejection[] = [
  {
    path: "bundle/mailer/heap-dump.bin",
    reason: "unsupported_media",
    why: "no allowed extension; the intake will not guess at an opaque blob",
  },
  {
    path: "bundle/mailer/truncated.log",
    reason: "binary_or_unknown",
    why: "claims a .log extension but carries NUL bytes, so it is not decodable text",
  },
  {
    path: "bundle/inner-bundle.zip",
    reason: "nested_archive",
    why: "an archive inside the archive is refused rather than recursively expanded",
  },
] as const;

const COLLECTOR_NOTES = [
  "# Collector notes",
  "",
  "Synthetic notes bundled with the fixture archive.",
  "",
  "- Pulled the mailer and deploy logs off the two hosts that were still up.",
  "- The heap dump is included in case it is useful; I cannot read it myself.",
  "- One mailer log came back truncated mid-write and looks corrupt.",
  "- I did not filter anything out of this bundle by hand.",
  "",
].join("\n");

const TRUNCATED_LOG = Buffer.concat([
  Buffer.from("2026-03-14 02:17:03 ERROR mailer.smtp    send failed id=syn-mailer-1", "utf8"),
  // A write that stopped mid-line and left the tail of the file as NULs. This
  // is what makes the entry undecodable rather than merely unusual.
  Buffer.alloc(96, 0),
]);

const HEAP_DUMP = Buffer.from(
  Array.from({ length: 128 }, (_unused, index) => (index * 37) % 256),
);

/**
 * Deterministic bytes: the same archive every run, so a Computer Use
 * acceptance pass can be compared against the previous one.
 */
export function noisySupportBundle(): Buffer {
  return syntheticZip([
    { name: "bundle/mailer/mailer-offsetless.log", data: warRoomBytes("mailer-offsetless.log") },
    { name: "bundle/mailer/heap-dump.bin", data: HEAP_DUMP },
    { name: "bundle/mailer/truncated.log", data: TRUNCATED_LOG },
    { name: "bundle/deploy/deploy-utc.log", data: warRoomBytes("deploy-utc.log") },
    { name: "bundle/notes/collector-notes.md", data: Buffer.from(COLLECTOR_NOTES, "utf8") },
    // A bundle built by wrapping another bundle. Refused, not expanded.
    {
      name: "bundle/inner-bundle.zip",
      data: syntheticZip([
        { name: "inner/extra.log", data: Buffer.from("2026-03-14 02:18:00 INFO inner\n", "utf8") },
      ]),
    },
  ]);
}

/** Every path the archive contains, in the order it was written. */
export function noisyBundlePaths(): string[] {
  return [...NOISY_BUNDLE_ACCEPTED.map((row) => row.path), ...NOISY_BUNDLE_REJECTED.map((row) => row.path)];
}

/**
 * Timestamps used by the timezone journey.
 *
 * `ambiguous` is the literal string from the mailer log. It is deliberately not
 * an RFC3339 timestamp: the product must refuse it as an asserted event time.
 * `corrected` is the same wall-clock moment once a responder supplies the
 * offset they believe the emitting host was using.
 */
export const TIMEZONE_JOURNEY = {
  ambiguous: "2026-03-14 02:15:09",
  corrected: "2026-03-14T02:15:09-07:00",
  /** The deploy line the responder is trying to order the failure against. */
  deployUtc: "2026-03-14T09:12:31+00:00",
  /**
   * With the asserted -07:00 offset the mailer failure is 09:15:09Z, which is
   * after the 09:12:31Z deploy step. The catalog records that this ordering
   * rests on a human assertion about the host's clock, not on the log itself.
   */
  orderingRestsOn: "responder-asserted host offset of -07:00",
} as const;

/** Event times for the historical backfill journey, weeks before the write. */
export const BACKFILL_JOURNEY = {
  windowStart: "2026-03-14T02:10:00-07:00",
  firstFailure: "2026-03-14T02:15:09-07:00",
  recovery: "2026-03-14T03:02:00-07:00",
} as const;
