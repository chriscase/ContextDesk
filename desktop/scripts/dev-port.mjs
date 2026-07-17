#!/usr/bin/env node
/**
 * Pick a free localhost TCP port for ContextDesk Vite/Tauri dev.
 *
 * Strategy (multi-Tauri-app machines):
 * 1. Prefer CD_DEV_PORT if set (explicit override).
 * 2. Else start at ContextDesk base port (1450) — NOT Tauri template 1420.
 * 3. Scan upward until a free port is found (max +40).
 *
 * Usage:
 *   node scripts/dev-port.mjs          # print free port
 *   node scripts/dev-port.mjs --json   # {"port":1450,"source":"base"}
 */
import net from "node:net";

/** Unique-ish base so we don't fight every `create-tauri-app` on 1420. */
export const CONTEXTDESK_BASE_PORT = 1450;
const SCAN_RANGE = 40;

function tryListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => {
      server.close(() => resolve(true));
    });
  });
}

export async function pickDevPort() {
  const envRaw = process.env.CD_DEV_PORT || process.env.PORT;
  if (envRaw) {
    const p = Number(envRaw);
    if (!Number.isInteger(p) || p < 1024 || p > 65535) {
      throw new Error(`Invalid CD_DEV_PORT/PORT: ${envRaw}`);
    }
    const free = await tryListen(p);
    if (!free) {
      throw new Error(
        `CD_DEV_PORT=${p} is already in use. Free it or unset CD_DEV_PORT to auto-pick.`,
      );
    }
    return { port: p, source: "env" };
  }

  for (let i = 0; i <= SCAN_RANGE; i++) {
    const port = CONTEXTDESK_BASE_PORT + i;
    if (await tryListen(port)) {
      return {
        port,
        source: i === 0 ? "base" : "scan",
      };
    }
  }
  throw new Error(
    `No free port in ${CONTEXTDESK_BASE_PORT}–${CONTEXTDESK_BASE_PORT + SCAN_RANGE}. Set CD_DEV_PORT=…`,
  );
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("dev-port.mjs") ||
    process.argv[1].includes("dev-port"));

if (isMain) {
  const json = process.argv.includes("--json");
  pickDevPort()
    .then((r) => {
      if (json) console.log(JSON.stringify(r));
      else console.log(String(r.port));
    })
    .catch((e) => {
      console.error(e.message || e);
      process.exit(1);
    });
}
