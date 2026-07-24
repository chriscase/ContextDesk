/**
 * Pure navigation tests for SessionWizard shell (#444).
 */

import { describe, expect, it } from "vitest";
import {
  createWizardNav,
  wizardNavBack,
  wizardNavCancel,
  wizardNavContinue,
  wizardNavSkip,
  LOG_INGEST_PIPELINE,
  phaseLabel,
} from "./types";
import { WIZARD_CATALOG, getWizard, LOG_TROUBLESHOOTING_WIZARD } from "./registry";

import { buildLogTriageStarterPrompt, LOG_TRIAGE_STARTER_PROMPT } from "./registry";

describe("buildLogTriageStarterPrompt", () => {
  it("embeds corpus id so the agent need not ask the user", () => {
    const seed = buildLogTriageStarterPrompt({
      corpusId: "abc-def-12",
      sessionContext: true,
    });
    expect(seed).toContain("abc-def-12");
    expect(seed).toContain('corpus="abc-def-12"');
    expect(seed).toMatch(/Do not ask me for a corpus id/i);
    expect(seed).toMatch(/session context/i);
  });

  it("falls back to generic when nothing was attached", () => {
    expect(buildLogTriageStarterPrompt({})).toBe(LOG_TRIAGE_STARTER_PROMPT);
  });
});

describe("wizardNav", () => {
  it("advances, backs, skips, and cancels without blocking a blank chat path", () => {
    let s = createWizardNav(LOG_TROUBLESHOOTING_WIZARD.steps.length);
    expect(s.stepIndex).toBe(0);
    s = wizardNavContinue(s);
    expect(s.stepIndex).toBe(1);
    s = wizardNavBack(s);
    expect(s.stepIndex).toBe(0);
    s = wizardNavSkip(s);
    expect(s.stepIndex).toBe(1);
    s = wizardNavCancel(s);
    expect(s.cancelled).toBe(true);
    // further continue is no-op when cancelled
    const frozen = wizardNavContinue(s);
    expect(frozen.stepIndex).toBe(s.stepIndex);
    expect(frozen.cancelled).toBe(true);
  });

  it("completes on last step", () => {
    let s = createWizardNav(2);
    s = wizardNavContinue(s);
    expect(s.stepIndex).toBe(1);
    s = wizardNavContinue(s);
    expect(s.completed).toBe(true);
  });
});

describe("wizard catalog", () => {
  it("registers log troubleshooting and at least one expansion wizard", () => {
    expect(WIZARD_CATALOG.length).toBeGreaterThanOrEqual(2);
    expect(getWizard("log-troubleshooting")?.skillPinId).toBe("log-triage");
    expect(getWizard("memory-primer")).toBeTruthy();
  });
});

describe("process pipeline labels", () => {
  it("exposes multi-phase log ingest pipeline for progress UI", () => {
    expect(LOG_INGEST_PIPELINE).toEqual([
      "scan",
      "parse",
      "template",
      "redact",
      "store",
      "embed",
    ]);
    expect(phaseLabel("template")).toBe("Template");
  });
});
