/**
 * Scenario: 25k demo import — zone-less timestamps in golden corpus,
 * truthful progress and cancel/retry, atomic corpus publication (host path).
 * Primary path: production demo install (install_demo_log_corpus).
 *
 * Order matters: cancel/retry must run before a successful install finishes
 * without cancel in this session.
 */
import {
  cancelAndRetryDemoInstall,
  installDemo25k,
  enterAppOpenLogs,
  screenshot,
  TIMEOUTS,
} from "./helpers.mjs";

describe("02 import 25k demo (release-host path)", () => {
  it("cancel mid-install surfaces cancel UI then retry recovers", async () => {
    const t0 = Date.now();
    const result = await cancelAndRetryDemoInstall();
    await screenshot("02-cancel-retry");
    // Must have exercised cancel acknowledgement and/or retry — helper throws otherwise
    if (!result.cancelled && !result.retried) {
      throw new Error(`cancel/retry returned without proof: ${JSON.stringify(result)}`);
    }
    // After helper, demo must be installed (retry or follow-up install)
    const body = await $("body").getText();
    if (!/Demo installed|Demo already installed/i.test(body)) {
      throw new Error("after cancel/retry, demo is not installed");
    }
    if (Date.now() - t0 > TIMEOUTS.import25k * 2) {
      throw new Error("cancel+retry exceeded 2× import budget");
    }
  });

  it("install path reaches Demo installed / already installed with progress contract", async () => {
    // Idempotent if prior test already installed via retry
    await installDemo25k();
    await screenshot("02-demo-installed");
    const body = await $("body").getText();
    if (!/Demo installed|Demo already installed/i.test(body)) {
      throw new Error("demo install result copy missing");
    }
    const enterLogs = await $(`button=Enter app · Open Logs`);
    const enter = await $(`button=Enter app`);
    const ok =
      (await enterLogs.isExisting()) || (await enter.isExisting());
    if (!ok) throw new Error("Enter app CTA missing after demo install");
  });

  it("enter app opens Logs with corpus selected after install", async () => {
    await enterAppOpenLogs();
    await screenshot("02-logs-library");
    const body = await $("body").getText();
    const hasCorpus =
      /Demo · seven-day|Open Explorer|25,?000|performance triage/i.test(body);
    if (!hasCorpus) {
      throw new Error("Logs library does not show demo corpus / Open Explorer");
    }
  });
});
