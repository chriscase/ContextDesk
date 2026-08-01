import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import {
  assertPortFree,
  findFreePort,
  runProcessWithTimeout,
  waitForOwnedPort,
} from "./process.mjs";

describe("driver process isolation", () => {
  it("allocates a free port and rejects a stale listener", async () => {
    const port = await findFreePort();
    await assertPortFree(port);

    const stale = createServer();
    await new Promise((resolve, reject) => {
      stale.once("error", reject);
      stale.listen(port, "127.0.0.1", resolve);
    });
    await assert.rejects(() => assertPortFree(port), /already in use/);
    await new Promise((resolve, reject) =>
      stale.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it("terminates a timed-out process tree instead of returning success", async () => {
    const result = await runProcessWithTimeout(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { timeoutMs: 50 },
    );
    assert.equal(result.timedOut, true);
    assert.match(String(result.error), /timed out/);
    assert.notEqual(result.status, 0);
  });

  it("fails immediately when the owned driver cannot spawn", async () => {
    const port = await findFreePort();
    const child = spawn("definitely-not-a-real-tauri-driver-command", [], {
      stdio: "ignore",
    });
    await assert.rejects(
      () => waitForOwnedPort(child, port, 2_000),
      /spawn failed|ENOENT/,
    );
  });
});
