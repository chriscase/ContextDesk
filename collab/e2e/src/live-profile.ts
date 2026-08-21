import { existsSync, readFileSync } from "node:fs";

export interface LiveProfile {
  baseUrl: string;
  username: string;
  passwordEnv: string;
}

export function loadLiveProfile():
  | { ok: true; profile: LiveProfile; password: string }
  | { ok: false; reason: string } {
  const path = process.env.COLLAB_E2E_LIVE_PROFILE?.trim();
  if (!path) {
    return { ok: false, reason: "COLLAB_E2E_LIVE_PROFILE is unset" };
  }
  if (!existsSync(path)) {
    return { ok: false, reason: `live profile file missing: ${path}` };
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const baseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl : "";
  const username = typeof raw.username === "string" ? raw.username : "";
  const passwordEnv = typeof raw.passwordEnv === "string" ? raw.passwordEnv : "";
  if (!baseUrl || !username || !passwordEnv) {
    return { ok: false, reason: "live profile requires baseUrl, username, passwordEnv" };
  }
  if (baseUrl.includes("://") === false) {
    return { ok: false, reason: "live profile baseUrl must be an absolute URL" };
  }
  const password = process.env[passwordEnv]?.trim() ?? "";
  if (!password) {
    return { ok: false, reason: `password env ${passwordEnv} is empty` };
  }
  return { ok: true, profile: { baseUrl, username, passwordEnv }, password };
}

export function redactLiveText(text: string, username: string, password: string): string {
  return text.split(password).join("[redacted-password]").split(username).join("[redacted-user]");
}
