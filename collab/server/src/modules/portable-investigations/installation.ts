import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INSTALLATION_ID_RE = /^inst-[a-z0-9]{8,64}$/;
const INSTALLATION_ID_FILE = "portable-installation-id";

function parseInstallationId(raw: string): string {
  const value = raw.trim();
  if (!INSTALLATION_ID_RE.test(value)) {
    throw new Error("portable installation id is invalid");
  }
  return value;
}
/**
 * Load the host's opaque, durable portable-archive identity. An explicit
 * deployment value wins; otherwise the evidence volume owns a generated id.
 */
export async function loadPortableInstallationId(
  evidenceRoot: string,
  configured?: string,
): Promise<string> {
  if (configured?.trim()) return parseInstallationId(configured);

  await mkdir(evidenceRoot, { recursive: true });
  const path = join(evidenceRoot, INSTALLATION_ID_FILE);
  try {
    return parseInstallationId(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }

  const generated = `inst-${randomBytes(16).toString("hex")}`;
  try {
    await writeFile(path, `${generated}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return generated;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return parseInstallationId(await readFile(path, "utf8"));
  }
}
