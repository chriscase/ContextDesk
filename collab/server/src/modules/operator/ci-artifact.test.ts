import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertReleaseArtifactSafe, sanitizeCiArtifacts } from "./ci-artifact.js";

const here = new URL("../../../../contracts/fixtures/", import.meta.url);

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(name, here), "utf8")) as unknown;
}

describe("hosted CI artifact sanitizer", () => {
  it("accepts the provider-free qualification, doctor, and live reports", async () => {
    const qualification = await fixture("qualification-report.valid.json");
    const doctor = await fixture("doctor-report.valid.json");
    const live = await fixture("live-qualification-report.valid.json");
    expect(() => assertReleaseArtifactSafe({ reports: [qualification, doctor, live] })).not.toThrow();
  });

  it("rejects an empty report wrapper and can require named outputs", async () => {
    expect(() => assertReleaseArtifactSafe({ reports: [] })).toThrow(/must not be empty/);
    const root = await mkdtemp(join(tmpdir(), "cd-collab-ci-required-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "doctor.json"), JSON.stringify(await fixture("doctor-report.valid.json")));
    await expect(
      sanitizeCiArtifacts({
        sourceDir: source,
        destDir: destination,
        requiredNames: ["doctor.json", "qualify-postgres.json"],
      }),
    ).rejects.toThrow(/qualify-postgres\.json/);
    await rm(root, { recursive: true, force: true });
  });

  it("rejects a live provider lane even when the rest of the report is typed", async () => {
    const report = (await fixture("live-qualification-report.valid.json")) as Record<string, unknown>;
    report.liveOptIn = true;
    report.confirmed = true;
    const lanes = report.lanes as Array<Record<string, unknown>>;
    lanes[0] = {
      ...lanes[0],
      configured: true,
      ran: true,
      profileId: "profile-gpt-oss",
      modelId: "gpt-oss-120b",
      provider: "employer-gateway",
      label: "GPT OSS",
      status: "completed",
      skippedReason: null,
      startedAt: "2026-08-20T12:00:00Z",
      finishedAt: "2026-08-20T12:00:01Z",
    };
    expect(() => assertReleaseArtifactSafe(report)).toThrow(/must not include live provider runs/);
  });

  it("fails closed on secrets and writes only validated JSON", async () => {
    const root = await mkdtemp(join(tmpdir(), "cd-collab-ci-artifacts-"));
    const source = join(root, "source");
    const destination = join(root, "destination");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "report.json"), JSON.stringify(await fixture("doctor-report.valid.json")));
    await expect(sanitizeCiArtifacts({ sourceDir: source, destDir: destination })).resolves.toHaveLength(1);
    expect(JSON.parse(await readFile(join(destination, "report.json"), "utf8"))).toHaveProperty(
      "schemaId",
      "cd-collab.doctor_report.v1",
    );
    await writeFile(
      join(source, "unsafe.json"),
      JSON.stringify({ schemaId: "cd-collab.doctor_report.v1", prompt: "do not export" }),
    );
    await expect(sanitizeCiArtifacts({ sourceDir: source, destDir: destination })).rejects.toThrow(
      /release artifact rejected/,
    );
    await rm(root, { recursive: true, force: true });
  });
});
