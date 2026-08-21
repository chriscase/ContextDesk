import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorExitCode, renderDoctorSummary } from "@cd-collab/contracts";
import { mergeEnv, parseEnvFile, runDoctor } from "./modules/operator/index.js";

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const out = argValue(argv, "--out");
  const envFile = argValue(argv, "--env-file");
  let env: NodeJS.ProcessEnv = { ...process.env };
  if (envFile) {
    const text = await readFile(envFile, "utf8");
    env = mergeEnv(env, parseEnvFile(text));
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const collabRoot = join(here, "..", "..");
  const report = runDoctor({
    env,
    collabRoot,
    cwd: process.cwd(),
    nodeVersion: process.versions.node,
  });
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  if (out) {
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, payload, "utf8");
    process.stderr.write(`${renderDoctorSummary(report)}\n`);
  } else if (json) {
    process.stdout.write(payload);
  } else {
    process.stdout.write(`${renderDoctorSummary(report)}\n`);
  }
  process.exitCode = doctorExitCode(report);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "doctor failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
