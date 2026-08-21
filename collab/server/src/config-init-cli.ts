import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONFIG_INIT_PROFILES,
  initConfig,
  type ConfigInitProfile,
} from "./modules/operator/index.js";

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  return argv[index + 1];
}

function isProfile(value: string | undefined): value is ConfigInitProfile {
  return CONFIG_INIT_PROFILES.includes(value as ConfigInitProfile);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const nonInteractive = argv.includes("--yes") || argv.includes("--non-interactive") || !output.isTTY;
  const force = argv.includes("--force");
  const outputPath = argValue(argv, "--output") ?? ".env.local";
  const profileRaw = argValue(argv, "--profile") ?? "demo";
  if (!isProfile(profileRaw)) {
    throw new Error("config:init --profile must be demo, postgres, or ldap");
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const collabRoot = join(here, "..", "..");
  const request: Parameters<typeof initConfig>[0] = {
    collabRoot,
    cwd: process.cwd(),
    output: outputPath,
    profile: profileRaw,
    force,
    nonInteractive,
  };
  if (!nonInteractive) {
    request.confirmOverwrite = async () => {
      const rl = createInterface({ input, output });
      try {
        const answer = await rl.question("Overwrite existing file? [y/N] ");
        return /^y(es)?$/i.test(answer.trim());
      } finally {
        rl.close();
      }
    };
  }
  const result = await initConfig(request);
  process.stderr.write(
    `wrote ${result.profile} config and created ${result.createdDirectories.length} local director${result.createdDirectories.length === 1 ? "y" : "ies"}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "config:init failed";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
