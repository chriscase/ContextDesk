#!/usr/bin/env node
/** Minimal JS/TS-friendly sketch for Incident Evidence Bundle v1 (directory form). */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  const st = await stat(path);
  return { bytes: st.size, sha256: hash.digest("hex") };
}

const root = "./incident-evidence-out";
const logRel = "logs/app.log";
const logPath = join(root, logRel);
await mkdir(dirname(logPath), { recursive: true });
await writeFile(logPath, "2024-01-15T12:00:00Z INFO synthetic\n");
const { bytes, sha256 } = await sha256File(logPath);

const manifest = {
  schemaId: "contextdesk.incident_evidence.v1",
  minReaderVersion: 1,
  bundleId: "example-js-bundle",
  createdAt: "2024-01-15T12:05:00Z",
  producer: { name: "example-js-collector", version: "0.1.0" },
  privacy: {
    redactionDeclared: true,
    containsCredentials: false,
    containsPii: false,
  },
  timeBasis: { timezone: "UTC", timezoneResolved: true },
  components: [
    {
      id: "log-app",
      role: "log",
      path: logRel,
      mediaType: "text/plain",
      bytes,
      sha256,
      sourceLabel: "app",
    },
  ],
};

await writeFile(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.error(`wrote ${root}`);
