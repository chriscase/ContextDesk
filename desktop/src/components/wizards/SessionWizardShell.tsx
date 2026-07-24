/**
 * Reusable multi-step session wizard shell (#444).
 * Modal overlay; optional; Escape cancels. Does not replace LAUNCH onboarding.
 */

import { useEffect, useId, useRef } from "react";
import { trapTabKey } from "../../lib/a11y";
import { StageArt } from "./StageArt";
import type { WizardDef, WizardStepDef } from "./types";

export type SessionWizardShellProps = {
  wizard: WizardDef;
  stepIndex: number;
  children: React.ReactNode;
  /** Disable Continue (validation). */
  continueDisabled?: boolean;
  continueLabel?: string;
  busy?: boolean;
  error?: string | null;
  onBack: () => void;
  onContinue: () => void;
  onSkip?: () => void;
  onCancel: () => void;
  /** Feature-detect Help (#449). */
  onLearnMore?: (helpPageId: string) => void;
  helpAvailable?: boolean;
};

export function SessionWizardShell({
  wizard,
  stepIndex,
  children,
  continueDisabled,
  continueLabel = "Continue",
  busy,
  error,
  onBack,
  onContinue,
  onSkip,
  onCancel,
  onLearnMore,
  helpAvailable,
}: SessionWizardShellProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const step: WizardStepDef | undefined = wizard.steps[stepIndex];
  const isFirst = stepIndex <= 0;
  const isLast = stepIndex >= wizard.steps.length - 1;

  useEffect(() => {
    const t = window.setTimeout(() => {
      panelRef.current
        ?.querySelector<HTMLElement>("button, [href], input, select, textarea")
        ?.focus();
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (!busy) onCancel();
        return;
      }
      if (panelRef.current) {
        trapTabKey(e, panelRef.current, document.activeElement);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [busy, onCancel, stepIndex]);

  const helpId = step?.helpPageId ?? wizard.helpPageId;

  return (
    <div className="session-wizard-overlay" role="presentation">
      <div
        ref={panelRef}
        className="session-wizard"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="session-wizard__header">
          <div>
            <p className="session-wizard__kicker">Guided setup</p>
            <h2 id={titleId} className="session-wizard__title">
              {wizard.title}
            </h2>
          </div>
          {helpId && helpAvailable && onLearnMore ? (
            <button
              type="button"
              className="session-wizard__learn"
              onClick={() => onLearnMore(helpId)}
            >
              Learn more
            </button>
          ) : helpId ? (
            <span className="session-wizard__learn session-wizard__learn--muted" title="Help center not available yet">
              Help: {helpId}
            </span>
          ) : null}
        </header>

        <ol className="session-wizard__steps" aria-label="Wizard steps">
          {wizard.steps.map((s, i) => {
            const done = i < stepIndex;
            const current = i === stepIndex;
            return (
              <li
                key={s.id}
                className="session-wizard__step"
                data-active={current ? "true" : "false"}
                data-done={done ? "true" : "false"}
                aria-current={current ? "step" : undefined}
              >
                <span className="session-wizard__step-dot" aria-hidden>
                  {done ? "✓" : i + 1}
                </span>
                <span className="session-wizard__step-label">{s.title}</span>
              </li>
            );
          })}
        </ol>

        <div className="session-wizard__body">
          {step?.stageSvgId ? (
            <StageArt id={step.stageSvgId} title={step.title} />
          ) : null}
          <div className="session-wizard__content">
            <h3 className="session-wizard__step-title">{step?.title}</h3>
            {children}
            {error ? (
              <p className="session-wizard__error" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </div>

        <footer className="session-wizard__footer">
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <div className="session-wizard__footer-right">
            {!isFirst ? (
              <button type="button" onClick={onBack} disabled={busy}>
                Back
              </button>
            ) : null}
            {step?.allowSkip && onSkip && !isLast ? (
              <button type="button" onClick={onSkip} disabled={busy}>
                Skip
              </button>
            ) : null}
            <button
              type="button"
              className="session-wizard__primary"
              onClick={onContinue}
              disabled={busy || continueDisabled}
            >
              {busy ? "Working…" : isLast ? "Finish" : continueLabel}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
