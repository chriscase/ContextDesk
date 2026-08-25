/** Parse KEY=VALUE env files without interpolating or logging values. */

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  // PowerShell and Windows editors may emit a UTF-8 BOM. Treat it as encoding
  // metadata, not as part of the first environment key.
  const normalized = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = normalized.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? "";
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new Error(`env file line ${index + 1} is malformed`);
    }
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`env file line ${index + 1} is malformed`);
    }
    out[key] = unquote(line.slice(eq + 1).trim());
  }
  return out;
}
function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function mergeEnv(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string>,
): NodeJS.ProcessEnv {
  return { ...base, ...overlay };
}
