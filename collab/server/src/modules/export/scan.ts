export type PrivacyScanRule = "credential" | "internal_hostname" | "raw_private_evidence";

export interface PrivacyScanFinding {
  rule: PrivacyScanRule;
  path: string;
  excerpt: string;
}

export class PrivacyScanError extends Error {
  readonly findings: PrivacyScanFinding[];

  constructor(findings: PrivacyScanFinding[]) {
    super("privacy_scan_failed");
    this.name = "PrivacyScanError";
    this.findings = findings;
  }
}

const CREDENTIAL_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "aws_access_key", re: /AKIA[0-9A-Z]{16}/g },
  { name: "private_key", re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/g },
  {
    name: "secret_assignment",
    re: /(?:password|passwd|pwd|secret|api[_-]?key|token|bearer)\s*[:=]\s*\S+/gi,
  },
];

function walkStrings(value: unknown, path: string, out: { path: string; text: string }[]): void {
  if (typeof value === "string") {
    out.push({ path, text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkStrings(item, `${path}[${i}]`, out));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      walkStrings(child, `${path}.${key}`, out);
    }
  }
}

function clip(text: string): string {
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function hostnameHits(text: string, suffixes: readonly string[]): string[] {
  const hits: string[] = [];
  for (const suffix of suffixes) {
    const escaped = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b[a-zA-Z0-9._-]+${escaped}\\b`, "gi");
    const found = text.match(re);
    if (found) hits.push(...found);
  }
  return hits;
}

export function scanShareSafePayload(
  payload: unknown,
  markdown: string,
  suffixes: readonly string[],
): PrivacyScanFinding[] {
  const findings: PrivacyScanFinding[] = [];
  const strings = [{ path: "$.markdown", text: markdown }];
  walkStrings(payload, "$", strings);

  for (const { path, text } of strings) {
    for (const pattern of CREDENTIAL_PATTERNS) {
      const matches = text.match(pattern.re);
      if (!matches) continue;
      for (const match of matches) {
        findings.push({
          rule: "credential",
          path,
          excerpt: `${pattern.name}: ${clip(match)}`,
        });
      }
    }
    for (const host of hostnameHits(text, suffixes)) {
      findings.push({
        rule: "internal_hostname",
        path,
        excerpt: clip(host),
      });
    }
  }

  if (payload && typeof payload === "object") {
    const rec = payload as { evidence?: { privacyClass?: string; content?: string | null; bytesIncluded?: boolean }[] };
    for (const [i, item] of (rec.evidence ?? []).entries()) {
      if (item.privacyClass === "owner_only" && (item.bytesIncluded || item.content !== null)) {
        findings.push({
          rule: "raw_private_evidence",
          path: `$.evidence[${i}]`,
          excerpt: "owner_only bytes or content present",
        });
      }
    }
    const excerpts = (payload as { excerpts?: { privacyClass?: string; content?: string | null; bodyIncluded?: boolean }[] })
      .excerpts;
    for (const [i, item] of (excerpts ?? []).entries()) {
      if (item.privacyClass === "owner_only" && (item.bodyIncluded || item.content !== null)) {
        findings.push({
          rule: "raw_private_evidence",
          path: `$.excerpts[${i}]`,
          excerpt: "owner_only bytes or content present",
        });
      }
    }
  }

  return findings;
}

export function assertShareSafeClean(
  payload: unknown,
  markdown: string,
  suffixes: readonly string[],
): void {
  const findings = scanShareSafePayload(payload, markdown, suffixes);
  if (findings.length > 0) {
    throw new PrivacyScanError(findings);
  }
}
