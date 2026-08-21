import { sanitizeCiArtifacts } from "./modules/operator/index.js";

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function requiredNames(argv: string[]): string[] | undefined {
  const value = argValue(argv, "--require");
  if (!value) return undefined;
  const names = value.split(",").map((name) => name.trim()).filter(Boolean);
  return names.length > 0 ? names : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sourceDir = argValue(argv, "--in");
  const destDir = argValue(argv, "--out");
  if (!sourceDir || !destDir) throw new Error("ci-artifact --in DIR --out DIR is required");
  const required = requiredNames(argv);
  const written = await sanitizeCiArtifacts({
    sourceDir,
    destDir,
    ...(required ? { requiredNames: required } : {}),
  });
  process.stderr.write(`sanitized ${written.length} release artifact(s)\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "artifact sanitizer failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
