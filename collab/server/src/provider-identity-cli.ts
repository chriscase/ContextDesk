import { readFile } from "node:fs/promises";
import {
  executeProviderIdentityOperation,
  mergeEnv,
  parseEnvFile,
  parseProviderIdentityCliArgs,
  providerIdentityErrorCode,
  PROVIDER_IDENTITY_OPERATOR_SCHEMA_ID,
  ProviderIdentityOperatorError,
} from "./modules/operator/index.js";

async function main(): Promise<void> {
  const args = parseProviderIdentityCliArgs(process.argv.slice(2));
  let env: NodeJS.ProcessEnv;
  try {
    const envBody = await readFile(args.envFile, "utf8");
    env = mergeEnv(process.env, parseEnvFile(envBody));
  } catch {
    throw new ProviderIdentityOperatorError("invalid_configuration");
  }
  const result = await executeProviderIdentityOperation({
    action: args.action,
    env,
    confirmed: args.confirmed,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({
    schemaId: PROVIDER_IDENTITY_OPERATOR_SCHEMA_ID,
    ok: false,
    code: providerIdentityErrorCode(error),
  })}\n`);
  process.exitCode = 1;
});
