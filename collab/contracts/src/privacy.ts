import { ContractViolation } from "./parse.js";

export const SHARE_SAFE_PRIVACY_RULES = [
  "url",
  "internal_hostname",
  "absolute_path",
  "credential",
  "request_id",
  "forbidden_key",
] as const;
export type ShareSafePrivacyRule = (typeof SHARE_SAFE_PRIVACY_RULES)[number];

export interface ShareSafePrivacyFinding {
  rule: ShareSafePrivacyRule;
  path: string;
  excerpt: string;
}

const CREDENTIAL_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "access key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "private key", re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g },
  { label: "bearer credential", re: /\bbearer\s+\S+/gi },
  { label: "OpenAI-shaped key", re: /\bsk-[a-z0-9_-]{8,}\b/gi },
  {
    label: "credential assignment",
    re: /\b(?:api[_-]?key|authorization|credential|password|passwd|pwd|secret|token|access[_-]?key|private[_-]?key)\s*[:=]\s*\S+/gi,
  },
];

const REQUEST_ID_PATTERNS: { label: string; re: RegExp }[] = [
  {
    label: "request id assignment",
    re: /\b(?:x[-_]?request[-_]?id|provider[-_]?request[-_]?id|request[-_]?id|requestid|req[-_]?id)\b\s*[:=]\s*\S+/gi,
  },
  { label: "request id value", re: /\breq-[a-z0-9][a-z0-9._-]{5,}\b/gi },
];

const UNIX_PATH = /(?:^|[\s"'`=(])\/(?!\/)[^\s"'`<>]+/g;
const WINDOWS_DRIVE_PATH = /\b[a-z]:[\\/][^\s"'`<>]*/gi;
const WINDOWS_UNC_PATH = /\\\\[a-z0-9._-]+\\[^\s"'`<>]+/gi;
const URI_SCHEME = /\b([a-z][a-z0-9+.-]{0,31}):(?:\/\/)?[^\s"'<>]*/gi;
const HOSTNAME = /\b(?:[a-z0-9-]+\.)+[a-z][a-z0-9-]*\b/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const PRIVATE_IPV6 = /\b(?:f[cd][0-9a-f]{2}|fe8[0-9a-f]):[0-9a-f:]+\b/gi;

function clip(text: string): string {
  return text.length > 64 ? `${text.slice(0, 64)}…` : text;
}

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function forbiddenKey(key: string): boolean {
  const normalized = normalizedKey(key);
  if (
    normalized.includes("requestid") ||
    normalized === "prompt" ||
    normalized === "prompts" ||
    normalized === "authorization" ||
    normalized === "credential" ||
    normalized === "credentials" ||
    normalized === "password" ||
    normalized === "passwd" ||
    normalized === "secret" ||
    normalized === "token" ||
    normalized === "apikey" ||
    normalized === "accesskey" ||
    normalized === "privatekey" ||
    normalized === "endpoint" ||
    normalized === "baseurl"
  ) {
    return true;
  }
  return (
    normalized.startsWith("raw") &&
    ["capture", "output", "body", "request", "response", "prompt"].some((part) =>
      normalized.includes(part),
    )
  );
}

function isPrivateIpv4(host: string): boolean {
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part > 255)) {
    return false;
  }
  const [a = -1, b = -1] = octets;
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isInternalHostname(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "localhost" ||
    /(?:^|[.-])(?:internal|intranet|corp|lan|local|localhost|localdomain)(?:[.-]|$)/.test(
      lower,
    ) ||
    lower.endsWith(".test")
  );
}

function matches(re: RegExp, text: string): string[] {
  re.lastIndex = 0;
  return [...text.matchAll(re)].map((match) => match[0]);
}

function scanText(path: string, text: string, findings: ShareSafePrivacyFinding[]): void {
  for (const hit of matches(WINDOWS_DRIVE_PATH, text)) {
    findings.push({ rule: "absolute_path", path, excerpt: clip(hit) });
  }
  for (const hit of matches(WINDOWS_UNC_PATH, text)) {
    findings.push({ rule: "absolute_path", path, excerpt: clip(hit) });
  }
  for (const hit of matches(UNIX_PATH, text)) {
    findings.push({ rule: "absolute_path", path, excerpt: clip(hit.trimStart()) });
  }
  URI_SCHEME.lastIndex = 0;
  for (const match of text.matchAll(URI_SCHEME)) {
    const scheme = match[1] ?? "";
    const hit = match[0];
    if (scheme.length === 1 && /^[a-z]:[\\/]/i.test(hit)) continue;
    findings.push({ rule: "url", path, excerpt: clip(hit) });
  }
  for (const host of matches(HOSTNAME, text)) {
    if (isInternalHostname(host)) {
      findings.push({ rule: "internal_hostname", path, excerpt: clip(host) });
    }
  }
  if (/\blocalhost\b/i.test(text)) {
    findings.push({ rule: "internal_hostname", path, excerpt: "localhost" });
  }
  if (/(?:^|[^0-9a-f])::1(?:[^0-9a-f]|$)/i.test(text)) {
    findings.push({ rule: "internal_hostname", path, excerpt: "::1" });
  }
  for (const host of matches(IPV4, text)) {
    if (isPrivateIpv4(host)) {
      findings.push({ rule: "internal_hostname", path, excerpt: host });
    }
  }
  for (const host of matches(PRIVATE_IPV6, text)) {
    findings.push({ rule: "internal_hostname", path, excerpt: clip(host) });
  }
  for (const pattern of CREDENTIAL_PATTERNS) {
    for (const hit of matches(pattern.re, text)) {
      findings.push({ rule: "credential", path, excerpt: `${pattern.label}: ${clip(hit)}` });
    }
  }
  for (const pattern of REQUEST_ID_PATTERNS) {
    for (const hit of matches(pattern.re, text)) {
      findings.push({ rule: "request_id", path, excerpt: `${pattern.label}: ${clip(hit)}` });
    }
  }
}

function scanValue(
  value: unknown,
  path: string,
  findings: ShareSafePrivacyFinding[],
): void {
  if (typeof value === "string") {
    scanText(path, value, findings);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanValue(item, `${path}[${index}]`, findings));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = `${path}.${key}`;
    if (forbiddenKey(key)) {
      findings.push({ rule: "forbidden_key", path: childPath, excerpt: key });
    }
    scanText(`${childPath}#key`, key, findings);
    scanValue(child, childPath, findings);
  }
}

export function scanShareSafePrivacy(value: unknown): ShareSafePrivacyFinding[] {
  const findings: ShareSafePrivacyFinding[] = [];
  scanValue(value, "$", findings);
  return findings;
}

export function assertShareSafePrivacy(value: unknown): void {
  const finding = scanShareSafePrivacy(value)[0];
  if (finding) {
    throw new ContractViolation(
      finding.path,
      `share-safe privacy gate rejected ${finding.rule}: ${finding.excerpt}`,
    );
  }
}

export function assertShareSafeAlias(path: string, value: string, prefix?: string): void {
  const expected = prefix ? new RegExp(`^${prefix}-[1-9][0-9]*$`) : /^[a-z][a-z0-9-]*-[1-9][0-9]*$/;
  if (!expected.test(value)) {
    throw new ContractViolation(path, prefix ? `expected ${prefix} alias` : "expected share-safe alias");
  }
}

export function assertShareSafeFingerprint(path: string, value: string): void {
  if (!/^(?:[a-z][a-z0-9_-]{0,31}-)?[a-f0-9]{64}$/.test(value)) {
    throw new ContractViolation(path, "expected a SHA-256 fingerprint");
  }
}

export function assertShareSafeTimestamp(path: string, value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new ContractViolation(path, "expected a UTC RFC3339 timestamp");
  }
}
