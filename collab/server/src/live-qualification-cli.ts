import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LIVE_PROFILE_ALIASES,
  parseLiveQualificationCatalog,
  renderLiveQualificationSummary,
  type LiveProfileAlias,
  type LiveQualificationCatalogV1,
} from "@cd-collab/contracts";
import { FilesystemEvidenceStore } from "./evidence/store.js";
import { MemoryAuditStore } from "./modules/audit/index.js";
import { CatalogService } from "./modules/catalog/index.js";
import { CaseService } from "./modules/cases/index.js";
import { runLiveQualification } from "./modules/qualification/index.js";
import {
  MemoryTriageJobStore,
  RustBridgeTriageExecutor,
  triageBridgeOptions,
  TriageRunService,
  type TriageProfileOption,
} from "./modules/triage-runs/index.js";

interface CliOptions {
  catalogPath: string | null;
  aliases: LiveProfileAlias[] | undefined;
  live: boolean;
  confirmed: boolean;
  concurrency: number;
  timeoutMs: number;
  json: boolean;
}

function nextValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseAliases(raw: string): LiveProfileAlias[] {
  const aliases = raw.split(",").map((value) => value.trim()).filter(Boolean);
  if (aliases.length === 0) throw new Error("--profiles requires at least one profile alias");
  const unknown = aliases.filter((alias) => !(LIVE_PROFILE_ALIASES as readonly string[]).includes(alias));
  if (unknown.length > 0) throw new Error(`unknown live profile alias: ${unknown[0]}`);
  return [...new Set(aliases)] as LiveProfileAlias[];
}

function boundedInteger(raw: string, flag: string, min: number, max: number): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${flag} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  let catalogPath = process.env.COLLAB_LIVE_PROFILE_CATALOG?.trim() || null;
  const configuredAliases = process.env.COLLAB_LIVE_PROFILES?.trim();
  let aliases: LiveProfileAlias[] | undefined = configuredAliases
    ? parseAliases(configuredAliases)
    : undefined;
  let live = false;
  let confirmed = false;
  let concurrency = 2;
  let timeoutMs = 300_000;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--catalog") {
      catalogPath = nextValue(argv, index, arg);
      index += 1;
    } else if (arg === "--profiles") {
      aliases = parseAliases(nextValue(argv, index, arg));
      index += 1;
    } else if (arg === "--concurrency") {
      concurrency = boundedInteger(nextValue(argv, index, arg), arg, 1, 4);
      index += 1;
    } else if (arg === "--timeout-ms") {
      timeoutMs = boundedInteger(nextValue(argv, index, arg), arg, 1_000, 900_000);
      index += 1;
    } else if (arg === "--live") {
      live = true;
    } else if (arg === "--yes" || arg === "--confirm-live") {
      confirmed = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "qualify:live [--catalog PATH] [--profiles ALIAS,...] [--live --yes] [--concurrency 1..4] [--timeout-ms N] [--json]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  if (confirmed && !live) throw new Error("--yes/--confirm-live requires --live");
  if (live && !confirmed) throw new Error("--live requires --yes/--confirm-live");
  if (live && !aliases) throw new Error("--live requires --profiles or COLLAB_LIVE_PROFILES");
  return { catalogPath, aliases, live, confirmed, concurrency, timeoutMs, json };
}

async function loadCatalog(path: string | null): Promise<LiveQualificationCatalogV1 | null> {
  if (!path) return null;
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  return parseLiveQualificationCatalog(raw);
}

function triageProfiles(catalog: LiveQualificationCatalogV1 | null): TriageProfileOption[] {
  return (catalog?.profiles ?? []).map((profile) => ({
    id: profile.profileId,
    label: profile.label,
    provider: profile.provider,
  }));
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const catalog = await loadCatalog(options.catalogPath);
  const root = await mkdtemp(join(tmpdir(), "cd-collab-live-qualification-"));
  try {
    const evidence = new FilesystemEvidenceStore({ rootDir: root });
    const audit = new MemoryAuditStore();
    const catalogService = new CatalogService(undefined, audit);
    const cases = new CaseService(evidence, audit, undefined, catalogService);
    const bridge = triageBridgeOptions(process.env);
    const triageRuns = new TriageRunService({
      cases,
      audit,
      jobs: new MemoryTriageJobStore(),
      profiles: triageProfiles(catalog),
      ...(bridge ? { gatewayExecutor: new RustBridgeTriageExecutor(bridge) } : {}),
    });
    const report = await runLiveQualification({
      cases,
      triageRuns,
      catalog,
      ...(options.aliases ? { aliases: options.aliases } : {}),
      liveOptIn: options.live,
      confirmed: options.confirmed,
      concurrency: options.concurrency,
      timeoutMs: options.timeoutMs,
    });
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else process.stdout.write(`${renderLiveQualificationSummary(report)}\n`);
    process.stderr.write(`${renderLiveQualificationSummary(report)}\n`);
    // An explicitly requested live run that cannot form a comparison must be
    // visible to CI/operators as a failure, rather than a successful no-op.
    if (report.verdict === "failed" || (options.live && report.verdict === "skipped")) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`live qualification failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  process.exitCode = 1;
});
