#!/usr/bin/env node
/**
 * Routes `npm run tauri -- …` / `npx tauri …` style invocations.
 * `dev` always goes through free-port-aware tauri-dev.mjs so newcomers
 * don't land on a hard-coded port conflict.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const args = process.argv.slice(2);
const sub = args[0];

const script =
  sub === "dev"
    ? path.join(__dirname, "tauri-dev.mjs")
    : path.join(desktopRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");

const childArgs = sub === "dev" ? args.slice(1) : args;

const child = spawn(process.execPath, [script, ...childArgs], {
  cwd: desktopRoot,
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
