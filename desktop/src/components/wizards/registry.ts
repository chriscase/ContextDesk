/**
 * Session wizard catalog (#442 / #444 / #447 / #448).
 */

import type { WizardDef } from "./types";

export const LOG_TROUBLESHOOTING_WIZARD: WizardDef = {
  id: "log-troubleshooting",
  title: "Log troubleshooting",
  description:
    "Point at a dump, ingest or attach logs, pin the triage skill, and start a ready chat.",
  thumbnailSvgId: "pipeline",
  helpPageId: "log-analysis-pipeline",
  skillPinId: "log-triage",
  steps: [
    {
      id: "welcome",
      title: "Welcome",
      stageSvgId: "pipeline",
      helpPageId: "log-analysis-pipeline",
      body: "info",
      allowSkip: true,
    },
    {
      id: "source",
      title: "Choose source",
      stageSvgId: "folder",
      body: "path_pick",
    },
    {
      id: "mode",
      title: "How to use logs",
      stageSvgId: "mode",
      body: "mode_select",
    },
    {
      id: "confirm",
      title: "Confirm SoftWrite",
      stageSvgId: "confirm",
      body: "confirm_softwrite",
    },
    {
      id: "run",
      title: "Import",
      stageSvgId: "pipeline",
      body: "run_progress",
    },
    {
      id: "ready",
      title: "Ready",
      stageSvgId: "ready",
      body: "ready",
    },
  ],
};

export const MEMORY_PRIMER_WIZARD: WizardDef = {
  id: "memory-primer",
  title: "Memory primer",
  description:
    "Learn how Review inbox vs durable Store work, then open Memory to continue.",
  thumbnailSvgId: "memory",
  helpPageId: "memory-overview",
  skillPinId: null,
  steps: [
    {
      id: "welcome",
      title: "Durable memory",
      stageSvgId: "memory",
      helpPageId: "memory-overview",
      body: "info",
      allowSkip: true,
    },
    {
      id: "review",
      title: "Review inbox",
      stageSvgId: "memory",
      body: "info",
    },
    {
      id: "ready",
      title: "Open Memory",
      stageSvgId: "ready",
      body: "ready",
    },
  ],
};

/** All registered wizards for the optional catalog. */
export const WIZARD_CATALOG: WizardDef[] = [
  LOG_TROUBLESHOOTING_WIZARD,
  MEMORY_PRIMER_WIZARD,
];

export function getWizard(id: string): WizardDef | undefined {
  return WIZARD_CATALOG.find((w) => w.id === id);
}

export const LOG_TRIAGE_STARTER_PROMPT =
  "I attached/ingested logs for this incident. Cluster the main problems, outline a timeline around the first ERROR spike, and hypothesize root cause with citations. Prefer log tools when a corpus is available.";
