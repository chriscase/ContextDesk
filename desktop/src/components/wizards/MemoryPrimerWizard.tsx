/**
 * Catalog expansion wizard — memory primer (#448).
 */

import { useState } from "react";
import { MEMORY_PRIMER_WIZARD } from "./registry";
import { SessionWizardShell } from "./SessionWizardShell";
import type { WizardOutcome } from "./types";

type Props = {
  sessionId: string;
  onComplete: (outcome: WizardOutcome) => void;
  onCancel: () => void;
  helpAvailable?: boolean;
  onLearnMore?: (helpPageId: string) => void;
};

export function MemoryPrimerWizard({
  sessionId,
  onComplete,
  onCancel,
  helpAvailable,
  onLearnMore,
}: Props) {
  const wizard = MEMORY_PRIMER_WIZARD;
  const [stepIndex, setStepIndex] = useState(0);

  const step = wizard.steps[stepIndex];

  return (
    <SessionWizardShell
      wizard={wizard}
      stepIndex={stepIndex}
      onBack={() => setStepIndex((i) => Math.max(0, i - 1))}
      onSkip={() => setStepIndex((i) => Math.min(i + 1, wizard.steps.length - 1))}
      onContinue={() => {
        if (stepIndex >= wizard.steps.length - 1) {
          onComplete({
            wizardId: wizard.id,
            composerSeed:
              "What should I capture in durable memory from our recent work? Propose review-inbox candidates only — no silent writes.",
            skillPinId: null,
            corpusId: null,
            sessionId,
            openPane: "memory",
            helpPageId: wizard.helpPageId,
          });
          return;
        }
        setStepIndex((i) => i + 1);
      }}
      onCancel={onCancel}
      helpAvailable={helpAvailable}
      onLearnMore={onLearnMore}
      continueLabel={step?.id === "ready" ? "Open Memory" : "Continue"}
    >
      {step?.id === "welcome" ? (
        <div className="wizard-copy">
          <p>
            Durable memory stores facts, decisions, and preferences you{" "}
            <strong>approve</strong>. ContextDesk never silently writes memory from
            chat — candidates land in a Review inbox first.
          </p>
        </div>
      ) : null}
      {step?.id === "review" ? (
        <div className="wizard-copy">
          <p>
            After a turn, cue extraction may propose items. Use{" "}
            <strong>Approve</strong> (SoftWrite) or <strong>Discard</strong>. Batch
            approve above a confidence threshold requires typing APPROVE.
          </p>
          <p className="muted">
            Ambient recall can inject relevant memory into the model context when
            enabled in Settings — still under the hard context budget.
          </p>
        </div>
      ) : null}
      {step?.id === "ready" ? (
        <div className="wizard-copy">
          <p>
            Finish to open the Memory pane. You can return to chat anytime; this wizard
            does not block New chat.
          </p>
        </div>
      ) : null}
    </SessionWizardShell>
  );
}
