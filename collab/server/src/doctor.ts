import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadRuntimeConfig, type Config } from "./config.js";
import { loadLdapConfig, loadLocalAuthAdapter } from "./modules/auth/index.js";
import { parseTriageProfileCatalog } from "./modules/triage-runs/index.js";

export const DOCTOR_SCHEMA_ID = "cd-collab.doctor_report.v1" as const;

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorReport {
  schemaId: typeof DOCTOR_SCHEMA_ID;
  ok: boolean;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  cwd?: string;
}

function check(id: string, status: DoctorStatus, message: string): DoctorCheck {
  return { id, status, message };
}

function versionTuple(raw: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(raw);
  if (!match) return null;
  const [, major, minor, patch] = match;
  if (!major || !minor || !patch) return null;
  return [Number(major), Number(minor), Number(patch)];
}

function versionAtLeast(raw: string, required: [number, number, number]): boolean {
  const actual = versionTuple(raw);
  if (!actual) return false;
  const [actualMajor, actualMinor, actualPatch] = actual;
  const [requiredMajor, requiredMinor, requiredPatch] = required;
  if (actualMajor !== requiredMajor) return actualMajor > requiredMajor;
  if (actualMinor !== requiredMinor) return actualMinor > requiredMinor;
  return actualPatch >= requiredPatch;
}

async function writablePath(path: string): Promise<"ok" | "missing-parent" | "error"> {
  let candidate = resolve(path);
  while (true) {
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) return "error";
      await access(candidate, fsConstants.W_OK);
      return candidate === resolve(path) ? "ok" : "missing-parent";
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return "error";
      candidate = parent;
    }
  }
}

async function readableDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(resolve(path));
    if (!info.isDirectory()) return false;
    await access(resolve(path), fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function safeDatabaseUrl(value: string | null): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  } catch {
    return false;
  }
}

function isExternallyBound(host: string): boolean {
  return !["127.0.0.1", "localhost", "::1"].includes(host.trim().toLowerCase());
}

function profileCheck(env: NodeJS.ProcessEnv, runnerConfigured: boolean): DoctorCheck {
  const raw = env.COLLAB_TRIAGE_PROFILE_CATALOG?.trim();
  if (!raw) {
    return check(
      "triage-profiles",
      runnerConfigured ? "error" : "warn",
      runnerConfigured
        ? "the host bridge is configured but no safe profile catalog is available"
        : "no host profile catalog configured; gateway execution is unavailable",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return check("triage-profiles", "error", "the host profile catalog is not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    return check("triage-profiles", "error", "the host profile catalog must be a JSON array");
  }
  const profiles = parseTriageProfileCatalog(raw);
  if (parsed.length === 0) {
    return check(
      "triage-profiles",
      runnerConfigured ? "error" : "warn",
      runnerConfigured
        ? "the host bridge is configured but the profile catalog is empty"
        : "the host profile catalog is empty",
    );
  }
  if (profiles.length !== parsed.length) {
    return check("triage-profiles", "error", "the host profile catalog contains an invalid or duplicate entry");
  }
  return check("triage-profiles", "ok", `${profiles.length} safe host profile label(s) configured`);
}

async function pathChecks(config: Config, checks: DoctorCheck[]): Promise<void> {
  const evidence = await writablePath(config.evidenceRoot);
  checks.push(
    evidence === "ok"
      ? check("evidence-root", "ok", "evidence storage exists and is writable")
      : evidence === "missing-parent"
        ? check("evidence-root", "ok", "evidence storage can be created under a writable parent")
        : check("evidence-root", "error", "evidence storage is not writable or is not a directory"),
  );

  if (!config.staticDir) {
    checks.push(check("static-assets", "warn", "no explicit static directory configured; API-only deployment is assumed"));
  } else {
    checks.push(
      await readableDirectory(config.staticDir)
        ? check("static-assets", "ok", "configured static directory is readable")
        : check("static-assets", "error", "configured static directory is missing or unreadable"),
    );
  }
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const checks: DoctorCheck[] = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  checks.push(
    versionAtLeast(nodeVersion, [22, 5, 0])
      ? check("node", "ok", "Node.js runtime meets the >=22.5.0 requirement")
      : check("node", "error", "Node.js runtime must be >=22.5.0"),
  );

  let config: Config | null = null;
  try {
    config = loadRuntimeConfig(env);
    checks.push(check("runtime-config", "ok", "runtime configuration is internally consistent"));
  } catch {
    checks.push(check("runtime-config", "error", "runtime configuration is incomplete or invalid"));
  }

  if (config) {
    if (config.storage === "postgres") {
      checks.push(
        safeDatabaseUrl(config.databaseUrl)
          ? check("database", "ok", "PostgreSQL application URL is configured")
          : check("database", "error", "PostgreSQL application URL is invalid"),
      );
      checks.push(
        safeDatabaseUrl(config.migrateDatabaseUrl)
          ? check("migrator", "ok", "PostgreSQL migrator URL is configured")
          : check("migrator", "error", "PostgreSQL migrator URL is invalid"),
      );
    } else {
      checks.push(check("database", "ok", "SQLite single-node storage is configured"));
      checks.push(check("migrator", "warn", "SQLite does not provide PostgreSQL role separation or multi-worker HA"));
    }
    await pathChecks(config, checks);

    const external = isExternallyBound(config.host);
    if (external && env.COLLAB_COOKIE_SECURE === "0") {
      checks.push(check("cookie-security", "error", "external binding cannot use insecure session cookies"));
    } else if (!external && env.COLLAB_COOKIE_SECURE === "0") {
      checks.push(check("cookie-security", "warn", "insecure cookies are enabled; keep this deployment private and local"));
    } else {
      checks.push(check("cookie-security", "ok", "session cookies require secure transport"));
    }

    if (config.authMode === "local") {
      try {
        loadLocalAuthAdapter(env);
        const raw = env.COLLAB_LOCAL_USERS ?? "";
        checks.push(
          /replace-me|change-me/i.test(raw)
            ? check("authentication", "warn", "local authentication is configured with a placeholder password")
            : check("authentication", "ok", "private local authentication is configured"),
        );
      } catch {
        checks.push(check("authentication", "error", "local authentication configuration is invalid"));
      }
    } else {
      try {
        const ldap = loadLdapConfig(env);
        if (!ldap.userDnTemplate && !ldap.userSearchBase) {
          checks.push(check("authentication", "error", "LDAP needs a user DN template or user search base"));
        } else {
          checks.push(check("authentication", "ok", "encrypted LDAP authentication configuration is valid"));
        }
        checks.push(
          ldap.groupSearchBase
            ? check("ldap-groups", "ok", "LDAP group lookup is configured")
            : check("ldap-groups", "warn", "LDAP group lookup is not configured; users will have no mapped groups"),
        );
      } catch {
        checks.push(check("authentication", "error", "LDAP authentication configuration is invalid or insecure"));
      }
    }
  }

  const runner = env.COLLAB_TRIAGE_RUNNER?.trim();
  if (!runner) {
    checks.push(check("host-bridge", "warn", "host bridge is not configured; only synthetic comparisons are available"));
  } else {
    try {
      await access(resolve(options.cwd ?? process.cwd(), runner), fsConstants.R_OK | fsConstants.X_OK);
      checks.push(check("host-bridge", "ok", "host bridge executable is readable and executable"));
    } catch {
      checks.push(check("host-bridge", "error", "configured host bridge executable is not accessible"));
    }
  }
  checks.push(profileCheck(env, Boolean(runner)));

  return {
    schemaId: DOCTOR_SCHEMA_ID,
    ok: checks.every((item) => item.status !== "error"),
    checks,
  };
}
