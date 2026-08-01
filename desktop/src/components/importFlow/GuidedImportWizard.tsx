/**
 * Guided-setup skin for the unified import flow (#751).
 *
 * The same `ImportFlow` the Logs pane renders inline, wrapped in the shared
 * `SessionWizardShell` chrome: two steps — Import, then Ready. Cancel mid
 * flow leaves the app usable; the flow's own cancel keeps working during a
 * run (the shell never traps a long ingest behind a disabled Cancel).
 */
import { useMemo, useState } from "react";
import type { EngineClient } from "@contextdesk/client";
import { SessionWizardShell } from "../wizards/SessionWizardShell";
import { LOG_IMPORT_WIZARD } from "../wizards/registry";
import { ImportFlow } from "./ImportFlow";

type Props = {
  engine: EngineClient;
  onCancel: () => void;
  onComplete: (corpusId: string | null) => void;
  onLearnMore?: (helpPageId: string) => void;
  helpAvailable?: boolean;
};

export function GuidedImportWizard({
  engine,
  onCancel,
  onComplete,
  onLearnMore,
  helpAvailable,
}: Props) {
  const [stepIndex, setStepIndex] = useState(0);
  const [publishedCorpusId, setPublishedCorpusId] = useState<string | null>(null);
  // Cancel/Escape never tears the wizard down directly: the flow receives a
  // close request, cancels a live run, stays truthfully visible until the
  // engine acknowledges, and only then calls back to actually close.
  const [exitSignal, setExitSignal] = useState(0);
  const step = LOG_IMPORT_WIZARD.steps[stepIndex]!;
  const isLast = stepIndex === LOG_IMPORT_WIZARD.steps.length - 1;
  const continueDisabled = step.id === "import" && publishedCorpusId === null;

  const requestClose = () => setExitSignal((signal) => signal + 1);

  const body = useMemo(() => {
    if (step.id === "import") {
      return (
        <ImportFlow
          engine={engine}
          variant="guided"
          onPublished={(corpusId) => setPublishedCorpusId(corpusId)}
          exitSignal={exitSignal}
          onExit={onCancel}
        />
      );
    }
    return (
      <p className="import-flow__done" role="status">
        {publishedCorpusId
          ? `Corpus ${publishedCorpusId} is ready. Open the Logs library or the Explorer to work with it.`
          : "Nothing was imported."}
      </p>
    );
  }, [step.id, engine, publishedCorpusId, exitSignal, onCancel]);

  return (
    <SessionWizardShell
      wizard={LOG_IMPORT_WIZARD}
      stepIndex={stepIndex}
      busy={false}
      continueDisabled={continueDisabled}
      continueLabel={isLast ? "Finish" : "Continue"}
      onCancel={step.id === "import" ? requestClose : onCancel}
      onBack={() => setStepIndex((index) => Math.max(0, index - 1))}
      onContinue={() => {
        if (isLast) onComplete(publishedCorpusId);
        else setStepIndex((index) => index + 1);
      }}
      onLearnMore={onLearnMore}
      helpAvailable={helpAvailable}
    >
      {body}
      {continueDisabled ? (
        <p className="import-flow__reason">
          Continue unlocks after an import publishes a corpus.
        </p>
      ) : null}
    </SessionWizardShell>
  );
}
