#!/usr/bin/env node
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { prepare25kZip } from "../harness/fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] || join(here, "..", "fixtures", "generated");
mkdirSync(outDir, { recursive: true });
const meta = prepare25kZip(join(outDir, "seven-day-25k.zip"));
console.log(JSON.stringify(meta, null, 2));
