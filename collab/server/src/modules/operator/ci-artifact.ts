import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DOCTOR_REPORT_SCHEMA_ID,
  QUALIFICATION_REPORT_SCHEMA_ID,
  parseDoctorReport,
  parseQualificationReport,
  scanShareSafePrivacy,
} from "@cd-collab/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function documents(raw: unknown): unknown[] {
  if (isRecord(raw) && Array.isArray(raw.reports)) return raw.reports;
  return [raw];
}

/**
 * Fail closed on prompts, raw captures, credentials, URLs/endpoints, request
 * ids, absolute paths, and private hostnames. Never include finding excerpts
 * in the thrown message (those can contain the leak).
 */
export function assertReleaseArtifactSafe(raw: unknown): void {
  const finding = scanShareSafePrivacy(raw)[0];
  if (finding) {
    throw new Error(`release artifact rejected by ${finding.rule} at ${finding.path}`);
  }
  for (const doc of documents(raw)) {
    if (!isRecord(doc) || typeof doc.schemaId !== "string") {
      throw new Error("release artifact must be a typed doctor or qualification report");
    }
    if (doc.schemaId === QUALIFICATION_REPORT_SCHEMA_ID) {
      const report = parseQualificationReport(doc);
      if (report.liveProfiles.some((profile) => profile.ran)) {
        throw new Error("release artifact must not mark live profiles as ran");
      }
      if (report.liveProfiles.some((profile) => profile.skippedReason === null)) {
        throw new Error("release artifact must name a skip reason for every live profile");
      }
      continue;
    }
    if (doc.schemaId === DOCTOR_REPORT_SCHEMA_ID) {
      parseDoctorReport(doc);
      continue;
    }
    throw new Error("release artifact has an unsupported schema");
  }
}

export async function sanitizeCiArtifacts(input: {
  sourceDir: string;
  destDir: string;
}): Promise<string[]> {
  const names = (await readdir(input.sourceDir)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) {
    throw new Error("no JSON reports to sanitize");
  }
  await mkdir(input.destDir, { recursive: true });
  const written: string[] = [];
  for (const name of names) {
    const rawText = await readFile(join(input.sourceDir, name), "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText) as unknown;
    } catch {
      throw new Error(`release artifact ${name} is not JSON`);
    }
    assertReleaseArtifactSafe(parsed);
    const dest = join(input.destDir, name);
    await writeFile(dest, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    written.push(dest);
  }
  return written;
}
