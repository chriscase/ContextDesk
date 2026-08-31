import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DOCTOR_CAVEATS,
  DOCTOR_CHECK_IDS,
  LIVE_PROFILE_ALIASES,
  parseDoctorReport,
  parseLiveQualificationCatalog,
  parseProfileCatalog,
  type DoctorCheckId,
  type DoctorCheckStatus,
  type DoctorCheckV1,
  type DoctorReportV1,
  type LiveProfileAlias,
} from "@cd-collab/contracts";
import { loadEvidenceS3Credentials, redactEvidenceS3Error } from "../../evidence/s3-secrets.js";
import { loadEvidenceStorageSettings } from "../../evidence/s3-settings.js";
import { loadLdapConfig } from "../auth/index.js";
import { nodeOperatorFs, type OperatorFs } from "./fs.js";

const MIN_NODE_MAJOR = 22;
const LIVE_ALIAS_SET = new Set<string>(LIVE_PROFILE_ALIASES);

export interface DoctorInput {
  env: NodeJS.ProcessEnv;
  collabRoot: string;
  cwd?: string;
  nodeVersion?: string;
  fs?: OperatorFs;
}

type Intent = "demo" | "deploy";

function intentOf(env: NodeJS.ProcessEnv): Intent | "invalid" {
  const mode = (env.COLLAB_AUTH_MODE ?? "").trim();
  if (mode === "demo" || mode === "local") return "demo";
  if (mode === "ldap") return "deploy";
  if (mode) return "invalid";
  if (env.COLLAB_DATABASE_URL?.trim() && env.COLLAB_LDAP_URL?.trim()) return "deploy";
  return "demo";
}

function resolvePath(cwd: string, value: string): string {
  return isAbsolute(value) ? value : resolve(cwd, value);
}

function placeholder(value: string | undefined): boolean {
  return Boolean(value && value.includes("replace-from-secret-store"));
}

function looksLikePostgresUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "postgres:" || parsed.protocol === "postgresql:";
  } catch {
    return false;
  }
}

function urlHasUserinfo(value: string): boolean {
  return /:\/\/[^/@]+:[^/@]+@/.test(value);
}

function nodeMajor(version: string): number | null {
  const match = version.trim().replace(/^v/i, "").match(/^(\d+)/);
  if (!match?.[1]) return null;
  return Number.parseInt(match[1], 10);
}

function check(
  id: DoctorCheckId,
  status: DoctorCheckStatus,
  summary: string,
): DoctorCheckV1 {
  return { id, status, summary };
}

function checkNode(version: string): DoctorCheckV1 {
  const major = nodeMajor(version);
  if (major === null) {
    return check("node_runtime", "error", "Node runtime version could not be parsed");
  }
  if (major < MIN_NODE_MAJOR) {
    return check("node_runtime", "error", `Node runtime is below the workspace floor of ${MIN_NODE_MAJOR}`);
  }
  return check("node_runtime", "ok", "Node runtime meets the workspace floor");
}

function checkArtifacts(root: string, fs: OperatorFs): DoctorCheckV1 {
  const required = ["contracts/dist/index.js", "server/dist/index.js"];
  const missing = required.filter((rel) => !fs.isFile(resolve(root, rel)));
  if (missing.length > 0) {
    return check("built_artifacts", "error", "compiled contracts or server artifacts are missing");
  }
  if (!fs.isFile(resolve(root, "web/dist/index.html"))) {
    return check("built_artifacts", "warn", "compiled web assets are missing");
  }
  return check("built_artifacts", "ok", "compiled contracts, server, and web artifacts are present");
}

function checkStorage(env: NodeJS.ProcessEnv, intent: Intent): DoctorCheckV1 {
  const url = env.COLLAB_DATABASE_URL?.trim();
  const migrate = env.COLLAB_MIGRATE_DATABASE_URL?.trim();
  if (!url) {
    if (intent === "demo") {
      return check("storage", "ok", "local demo storage does not require postgres");
    }
    return check("storage", "error", "postgres deployment requires a database URL");
  }
  if (!looksLikePostgresUrl(url) || (migrate && !looksLikePostgresUrl(migrate))) {
    return check("storage", "error", "storage URL must be a postgres URL");
  }
  if (placeholder(url) || placeholder(migrate)) {
    return check(
      "storage",
      "warn",
      "postgres URL is a secret-store placeholder; the database was not contacted",
    );
  }
  return check("storage", "ok", "postgres URL is configured; the database was not contacted");
}

/**
 * Windows access checks do not prove that the current token can create a file.
 * Use an exclusive, unpredictable probe and remove it before returning.
 */
export function probeWritableDirectory(path: string): boolean {
  const probe = join(
    path,
    `.contextdesk-write-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
  );
  let descriptor: number | undefined;
  let created = false;
  let usable = true;
  try {
    descriptor = openSync(probe, "wx", 0o600);
    created = true;
    writeFileSync(descriptor, "contextdesk operator write probe\n", "utf8");
    fsyncSync(descriptor);
  } catch {
    usable = false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        usable = false;
      }
    }
    if (created) {
      try {
        unlinkSync(probe);
      } catch {
        usable = false;
      }
    }
  }
  return usable;
}

function isWritableEvidenceDirectory(path: string, fs: OperatorFs): boolean {
  if (process.platform === "win32" && fs === nodeOperatorFs) {
    return probeWritableDirectory(path);
  }
  return fs.isWritableDirectory(path);
}

function doctorStorage(env: NodeJS.ProcessEnv): "postgres" | "sqlite" {
  const mode = (env.COLLAB_STORAGE ?? "postgres").trim().toLowerCase();
  return mode === "sqlite" ? "sqlite" : "postgres";
}

function checkEvidenceRoot(
  env: NodeJS.ProcessEnv,
  cwd: string,
  intent: Intent,
  fs: OperatorFs,
): DoctorCheckV1 {
  const raw = env.COLLAB_EVIDENCE_ROOT?.trim() || ".data/evidence";
  const path = resolvePath(cwd, raw);
  if (!fs.exists(path)) {
    return intent === "demo"
      ? check("evidence_root", "warn", "evidence root is missing; run the config initializer")
      : check("evidence_root", "error", "evidence root is missing");
  }
  if (!fs.isDirectory(path)) {
    return check("evidence_root", "error", "evidence root is not a directory");
  }
  if (!isWritableEvidenceDirectory(path, fs)) {
    return check("evidence_root", "error", "evidence root is not writable");
  }
  return check("evidence_root", "ok", "evidence root is a writable directory");
}

function checkEvidence(env: NodeJS.ProcessEnv, cwd: string, intent: Intent, fs: OperatorFs): DoctorCheckV1 {
  const root = checkEvidenceRoot(env, cwd, intent, fs);
  const controlRoot = env.COLLAB_EVIDENCE_ROOT?.trim() || ".data/evidence";
  const s3Requested = env.COLLAB_EVIDENCE_PROVIDER?.trim().toLowerCase() === "s3";
  let provider: "filesystem" | "s3" = "filesystem";
  try {
    const settings = loadEvidenceStorageSettings(env, {
      controlRoot,
      storage: doctorStorage(env),
    });
    provider = settings.provider;
    if (settings.provider === "s3") {
      loadEvidenceS3Credentials(env);
    }
  } catch (error) {
    if (root.status === "error" && s3Requested) {
      return check(
        "evidence_root",
        "error",
        "evidence root and s3 evidence configuration are invalid; bucket not contacted",
      );
    }
    const summary = redactEvidenceS3Error(error);
    return check(
      "evidence_root",
      "error",
      s3Requested ? `${summary}; bucket not contacted` : summary,
    );
  }
  if (provider === "filesystem") return root;
  if (root.status !== "ok") {
    return check(
      "evidence_root",
      root.status,
      `${root.summary}; s3 evidence configuration accepted; DeleteObject is required for staging, journal, and rollback cleanup; bucket not contacted`,
    );
  }
  if (doctorStorage(env) === "sqlite") {
    return check(
      "evidence_root",
      "warn",
      "evidence root is a writable directory; sqlite plus s3 is a single-process evaluation shape; DeleteObject is required for staging, journal, and rollback cleanup; bucket not contacted",
    );
  }
  return check(
    "evidence_root",
    "ok",
    "evidence root is a writable directory; s3 evidence configuration accepted; DeleteObject is required for staging, journal, and rollback cleanup; bucket not contacted",
  );
}

function checkStatic(env: NodeJS.ProcessEnv, cwd: string, fs: OperatorFs): DoctorCheckV1 {
  const raw = env.COLLAB_STATIC_DIR?.trim();
  if (!raw) {
    return check("static_dir", "warn", "static directory is unset; API-only");
  }
  const path = resolvePath(cwd, raw);
  if (!fs.isDirectory(path)) {
    return check("static_dir", "error", "static directory is missing");
  }
  if (!fs.isFile(resolve(path, "index.html"))) {
    return check("static_dir", "warn", "static directory has no index document");
  }
  return check("static_dir", "ok", "static directory is present");
}

function checkAuth(env: NodeJS.ProcessEnv, intent: Intent | "invalid"): DoctorCheckV1 {
  if (intent === "invalid") {
    return check("auth_mode", "error", "auth mode must be demo or ldap");
  }
  if (intent === "demo") {
    if (env.COLLAB_LDAP_URL?.trim()) {
      return check("auth_mode", "warn", "demo mode also has a directory URL; the directory was not contacted");
    }
    return check("auth_mode", "ok", "auth mode is local demo");
  }
  if (!env.COLLAB_LDAP_URL?.trim()) {
    return check("auth_mode", "error", "ldap mode requires a directory URL");
  }
  return check("auth_mode", "ok", "auth mode is ldap");
}

function checkLdap(env: NodeJS.ProcessEnv, intent: Intent): DoctorCheckV1 {
  const url = env.COLLAB_LDAP_URL?.trim();
  if (!url) {
    return intent === "demo"
      ? check("ldap_tls", "ok", "directory is not required in local demo mode")
      : check("ldap_tls", "error", "ldap deployment requires encrypted directory configuration");
  }
  try {
    const cfg = loadLdapConfig(env);
    if (!cfg.verifyTls) {
      return check("ldap_tls", "warn", "directory TLS verification is disabled; fixture-only");
    }
    return check(
      "ldap_tls",
      "ok",
      cfg.bindDn && cfg.bindPassword
        ? "directory transport is encrypted; live group refresh uses the service bind"
        : "directory transport is encrypted; login-time groups remain in the session until re-authentication",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "directory configuration rejected";
    if (/plaintext LDAP refused/i.test(message)) {
      return check("ldap_tls", "error", "plaintext LDAP refused");
    }
    if (/DEV_MODE/i.test(message)) {
      return check("ldap_tls", "error", "insecure directory TLS requires explicit dev mode");
    }
    return check("ldap_tls", "error", "directory configuration is invalid");
  }
}

function checkCookie(env: NodeJS.ProcessEnv, intent: Intent): DoctorCheckV1 {
  const insecure = env.COLLAB_COOKIE_SECURE === "0";
  if (insecure && intent === "deploy") {
    return check("cookie_security", "error", "insecure cookies are not allowed for ldap/postgres deployment");
  }
  if (insecure) {
    return check("cookie_security", "ok", "insecure cookies are allowed only for local demo");
  }
  return check("cookie_security", "ok", "secure cookies are configured");
}

function checkBridge(env: NodeJS.ProcessEnv, cwd: string, fs: OperatorFs): DoctorCheckV1 {
  const raw = (env.COLLAB_BRIDGE_BIN ?? env.COLLAB_TRIAGE_RUNNER)?.trim();
  if (!raw) {
    return check("rust_bridge", "warn", "host bridge is not configured; collab will not invoke it");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || urlHasUserinfo(raw)) {
    return check("rust_bridge", "error", "host bridge must be a filesystem path");
  }
  const path = resolvePath(cwd, raw);
  if (!fs.isFile(path)) {
    return check("rust_bridge", "error", "host bridge path is missing");
  }
  return check("rust_bridge", "ok", "host bridge path exists; the binary was not executed");
}

function knownAlias(value: string): value is LiveProfileAlias {
  return LIVE_ALIAS_SET.has(value);
}

function checkProfiles(
  env: NodeJS.ProcessEnv,
  cwd: string,
  intent: Intent,
  fs: OperatorFs,
): DoctorCheckV1 {
  const listed = (env.COLLAB_LIVE_PROFILES ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const liveCatalogPath = env.COLLAB_LIVE_PROFILE_CATALOG?.trim();
  const catalogPath = liveCatalogPath ?? env.COLLAB_PROFILE_CATALOG?.trim();
  const legacyCatalog = env.COLLAB_TRIAGE_PROFILE_CATALOG?.trim();
  if (legacyCatalog && !catalogPath) {
    try {
      const legacy = JSON.parse(legacyCatalog) as unknown;
      if (!Array.isArray(legacy) || legacy.length === 0 || legacy.some((row) => {
        if (typeof row !== "object" || row === null) return true;
        const value = row as Record<string, unknown>;
        return typeof value.id !== "string" || typeof value.label !== "string" || typeof value.provider !== "string";
      })) {
        return check("profile_catalog", "error", "legacy host profile catalog is malformed");
      }
    } catch {
      return check("profile_catalog", "error", "legacy host profile catalog is malformed");
    }
  }
  const vercel = env.COLLAB_LIVE_VERCEL === "1";
  if (listed.some((alias) => !knownAlias(alias))) {
    return check("profile_catalog", "error", "live profile list contains an unknown alias");
  }
  if (catalogPath) {
    const path = resolvePath(cwd, catalogPath);
    if (!fs.isFile(path)) {
      return check("profile_catalog", "error", "profile catalog file is missing");
    }
    try {
      if (liveCatalogPath) {
        parseLiveQualificationCatalog(JSON.parse(fs.readFile(path)) as unknown);
      } else {
        parseProfileCatalog(JSON.parse(fs.readFile(path)) as unknown);
      }
    } catch {
      return check("profile_catalog", "error", "profile catalog JSON is malformed");
    }
  }
  if (!catalogPath && listed.length === 0 && !vercel) {
    return intent === "deploy"
      ? check("profile_catalog", "warn", "live profile catalog is unset; live lanes stay skipped")
      : check("profile_catalog", "ok", "live profile catalog is unset; live lanes stay skipped");
  }
  return check(
    "profile_catalog",
    "ok",
    "live profile syntax is accepted; providers were not contacted",
  );
}

function checkPort(env: NodeJS.ProcessEnv): DoctorCheckV1 {
  const raw = env.COLLAB_PORT ?? "8787";
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return check("port", "error", "listen port must be an integer from 1 to 65535");
  }
  return check("port", "ok", "listen port is an integer in range");
}

export function runDoctor(input: DoctorInput): DoctorReportV1 {
  const fs = input.fs ?? nodeOperatorFs;
  const cwd = input.cwd ?? input.collabRoot;
  const intent = intentOf(input.env);
  const usableIntent: Intent = intent === "invalid" ? "demo" : intent;
  const checks: DoctorCheckV1[] = [
    checkNode(input.nodeVersion ?? process.versions.node),
    checkArtifacts(input.collabRoot, fs),
    checkStorage(input.env, usableIntent),
    checkEvidence(input.env, cwd, usableIntent, fs),
    checkStatic(input.env, cwd, fs),
    checkAuth(input.env, intent),
    checkLdap(input.env, usableIntent),
    checkCookie(input.env, usableIntent),
    checkBridge(input.env, cwd, fs),
    checkProfiles(input.env, cwd, usableIntent, fs),
    checkPort(input.env),
  ];
  const ordered = DOCTOR_CHECK_IDS.map((id) => {
    const found = checks.find((row) => row.id === id);
    if (!found) throw new Error(`doctor omitted check ${id}`);
    return found;
  });
  const errorCount = ordered.filter((row) => row.status === "error").length;
  const warnCount = ordered.filter((row) => row.status === "warn").length;
  return parseDoctorReport({
    schemaId: "cd-collab.doctor_report.v1",
    privacyClass: "share_safe",
    ok: errorCount === 0,
    errorCount,
    warnCount,
    checks: ordered,
    caveats: [...DOCTOR_CAVEATS],
  });
}
