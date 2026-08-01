#!/usr/bin/env node
/**
 * Print and exit based on Linux release-host WebDriver support.
 * Always exits 0 unless --require-release-host is set on an unsupported OS.
 */
import {
  supportMatrixSnapshot,
  releaseHostWebDriverSupport,
  EXIT,
} from "../harness/platform.mjs";

const requireReleaseHost = process.argv.includes("--require-release-host");
const snap = supportMatrixSnapshot();
console.log(JSON.stringify(snap, null, 2));
const s = releaseHostWebDriverSupport();
if (!s.supported) {
  console.error(`\nRELEASE_HOST_WEBDRIVER_UNSUPPORTED: ${s.reason}`);
  if (requireReleaseHost) process.exit(EXIT.UNSUPPORTED);
}
process.exit(EXIT.OK);
