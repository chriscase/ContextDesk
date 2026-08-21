import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DOCTOR_REPORT_SCHEMA_ID,
  LIVE_QUALIFICATION_REPORT_SCHEMA_ID,
  QUALIFICATION_REPORT_SCHEMA_ID,
  parseDoctorReport,
  parseLiveQualificationReport,
  parseQualificationReport,
  scanShareSafePrivacy,
} from "@cd-collab/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function documents(raw: unknown): unknown[] {
  if (isRecord(raw) && Array.isArray(raw.reports)) {
    if (raw.reports.length === 0) throw new Error("release artifact reports must not be empty");
    return raw.reports;
  }
  return [raw];
}

/**
 * Validate reports before they leave CI. This intentionally rejects provider
 * runs and fails closed on any privacy finding; it never includes the finding
 * excerpt in the thrown message because that excerpt may itself be sensitive.
 */
export function assertReleaseArtifactSafe(raw: unknown): void {
  const finding = scanShareSafePrivacy(raw)[0];
  if (finding) {
    throw new Error(`release artifact rejected by ${finding.rule} at ${finding.path}`);
  }
  for (const document of documents(raw)) {
    if (!isRecord(document) || typeof document.schemaId !== "string") {
      throw new Error("release artifact must be a typed operator report");
    }
    if (document.schemaId === QUALIFICATION_REPORT_SCHEMA_ID) {
      const report = parseQualificationReport(document);
      if (report.liveProfiles.some((profile) => profile.ran)) {
        throw new Error("release artifact must not mark live profiles as ran");
      }
      if (report.liveProfiles.some((profile) => profile.skippedReason === null)) {
        throw new Error("release artifact must name a skip reason for every live profile");
      }
      continue;
    }
    if (document.schemaId === LIVE_QUALIFICATION_REPORT_SCHEMA_ID) {
      const report = parseLiveQualificationReport(document);
      if (report.lanes.some((lane) => lane.ran)) {
        throw new Error("release artifact must not include live provider runs");
      }
      continue;
    }
    if (document.schemaId === DOCTOR_REPORT_SCHEMA_ID) {
      parseDoctorReport(document);
      continue;
    }
    throw new Error("release artifact has an unsupported schema");
  }
}

export async function sanitizeCiArtifacts(input: {
  sourceDir: string;
  destDir: string;
  requiredNames?: readonly string[];
}): Promise<string[]> {
  const names = (await readdir(input.sourceDir)).filter((name) => name.endsWith(".json")).sort();
  if (names.length === 0) throw new Error("no JSON reports to sanitize");
  const missing = (input.requiredNames ?? []).filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new Error(`required release artifact(s) missing: ${missing.join(", ")}`);
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
    const destination = join(input.destDir, name);
    await writeFile(destination, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    written.push(destination);
  }
  return written;
}
