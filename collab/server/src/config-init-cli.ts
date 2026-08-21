import { initializeLocalConfig } from "./config-init.js";

function valueAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  return value && !value.startsWith("-") ? value : null;
}

if (process.argv.includes("--help")) {
  process.stdout.write("Usage: npm run config:init -- --output PATH [--force]\n");
} else {
  const output = valueAfter("--output") ?? ".env.local";
  initializeLocalConfig(output, process.argv.includes("--force"))
    .then((target) => process.stdout.write(`Wrote local demo configuration to ${target}\n`))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : "configuration initialization failed"}\n`);
      process.exitCode = 1;
    });
}
