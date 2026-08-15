import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src", "db", "migrations");
const dest = join(root, "dist", "db", "migrations");

mkdirSync(dest, { recursive: true });
for (const name of readdirSync(src)) {
  if (name.endsWith(".sql")) {
    copyFileSync(join(src, name), join(dest, name));
  }
}
