export interface ExportPrivacyConfig {
  /** identity id or username → share-safe label. Admin-owned. Never emitted. */
  identityRedactions: Record<string, string>;
  internalHostnameSuffixes: string[];
}

export function parseRedactionMap(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw?.trim()) return out;
  for (const part of raw.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.lastIndexOf("=");
    if (eq <= 0) {
      throw new Error(`invalid COLLAB_EXPORT_REDACTION_MAP entry: ${trimmed}`);
    }
    const key = trimmed.slice(0, eq).trim();
    const label = trimmed.slice(eq + 1).trim();
    if (!key || !label) {
      throw new Error(`invalid COLLAB_EXPORT_REDACTION_MAP entry: ${trimmed}`);
    }
    out[key] = label;
  }
  return out;
}

export function loadExportPrivacyConfig(
  env: NodeJS.ProcessEnv = process.env,
): ExportPrivacyConfig {
  const suffixes = (env.COLLAB_EXPORT_INTERNAL_HOST_SUFFIXES ?? ".internal.example.test,.corp.example.test")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    identityRedactions: parseRedactionMap(env.COLLAB_EXPORT_REDACTION_MAP),
    internalHostnameSuffixes: suffixes,
  };
}

export function testExportPrivacyConfig(
  overrides: Partial<ExportPrivacyConfig> = {},
): ExportPrivacyConfig {
  return {
    identityRedactions: {
      "uid=alice,ou=people,dc=example,dc=test": "contributor",
      alice: "contributor",
      "uid=dave,ou=people,dc=example,dc=test": "administrator",
      dave: "administrator",
    },
    internalHostnameSuffixes: [".internal.example.test", ".corp.example.test"],
    ...overrides,
  };
}
