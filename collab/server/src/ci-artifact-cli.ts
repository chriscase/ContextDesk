import { sanitizeCiArtifacts } from "./modules/operator/index.js";

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sourceDir = argValue(argv, "--in");
  const destDir = argValue(argv, "--out");
  if (!sourceDir || !destDir) {
    throw new Error("ci-artifact --in DIR --out DIR is required");
  }
  const written = await sanitizeCiArtifacts({ sourceDir, destDir });
  process.stderr.write(`sanitized ${written.length} release artifact(s)\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "artifact sanitizer failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
