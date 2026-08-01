import { spawn, spawnSync } from "node:child_process";
import { createConnection, createServer } from "node:net";

export async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a loopback port"));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", (error) =>
      reject(new Error(`driver port 127.0.0.1:${port} is already in use: ${error}`)),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}

export async function waitForOwnedPort(child, port, timeoutMs = 30_000) {
  const started = Date.now();
  let spawnError = null;
  const onError = (error) => {
    spawnError = error;
  };
  child.on("error", onError);
  try {
    while (Date.now() - started <= timeoutMs) {
      if (spawnError) throw new Error(`tauri-driver spawn failed: ${spawnError}`);
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(
          `tauri-driver exited before listening (code=${child.exitCode}, signal=${child.signalCode})`,
        );
      }
      const open = await new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve(true);
        });
        socket.once("error", () => {
          socket.destroy();
          resolve(false);
        });
      });
      if (open) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(
      `tauri-driver did not listen on 127.0.0.1:${port} within ${timeoutMs}ms`,
    );
  } finally {
    child.off("error", onError);
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(value);
    };
    const onExit = () => finish(true);
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
  });
}

/** Terminate the driver and every application process it spawned. */
export async function terminateProcessTree(child, graceMs = 3_000) {
  if (!child?.pid) return;
  await terminatePidTree(child.pid, graceMs);
  await waitForExit(child, graceMs);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Terminate a detached process group by recorded leader PID. */
export async function terminatePidTree(pid, graceMs = 3_000) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
  const deadline = Date.now() + graceMs;
  while (pidAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!pidAlive(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* process already exited */
    }
  }
}

/** Run a command with bounded output and guaranteed process-tree teardown. */
export async function runProcessWithTimeout(command, args, opts = {}) {
  const maxBuffer = opts.maxBuffer ?? 64 * 1024 * 1024;
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  let overflow = false;
  const collect = (target, chunk) => {
    const next = target + chunk.toString();
    if (Buffer.byteLength(next) <= maxBuffer) return next;
    overflow = true;
    return next.slice(0, maxBuffer);
  };
  child.stdout?.on("data", (chunk) => {
    stdout = collect(stdout, chunk);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = collect(stderr, chunk);
  });

  let timedOut = false;
  const timer = setTimeout(async () => {
    timedOut = true;
    await terminateProcessTree(child);
  }, opts.timeoutMs ?? 30 * 60 * 1000);
  const result = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ code: null, signal: null, error }));
    child.once("exit", (code, signal) => resolve({ code, signal, error: null }));
  });
  clearTimeout(timer);
  if (overflow) stderr += "\n[gui-accept] output truncated at maxBuffer\n";
  return {
    status: result.code,
    signal: result.signal,
    error: timedOut
      ? new Error("command timed out; process tree terminated")
      : result.error,
    timedOut,
    stdout,
    stderr,
  };
}
