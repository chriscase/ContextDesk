/**
 * Optional guided-setup catalog (#447). Never blocks blank New chat.
 */

import { StageArt } from "./StageArt";
import { WIZARD_CATALOG } from "./registry";
import type { WizardDef } from "./types";

type Props = {
  open: boolean;
  onClose: () => void;
  onSelect: (wizardId: string) => void;
};

export function WizardCatalog({ open, onClose, onSelect }: Props) {
  if (!open) return null;
  return (
    <div className="session-wizard-overlay" role="presentation">
      <div
        className="wizard-catalog"
        role="dialog"
        aria-modal="true"
        aria-label="Guided setup catalog"
      >
        <header className="wizard-catalog__header">
          <div>
            <p className="session-wizard__kicker">Optional</p>
            <h2 className="session-wizard__title">Guided setup</h2>
          </div>
          <button type="button" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="wizard-catalog__intro">
          Walk through multi-step workflows with visual progress. You can always
          open a blank chat instead.
        </p>
        <ul className="wizard-catalog__list">
          {WIZARD_CATALOG.map((w: WizardDef) => (
            <li key={w.id}>
              <button
                type="button"
                className="wizard-catalog__card"
                onClick={() => onSelect(w.id)}
              >
                <StageArt
                  id={w.thumbnailSvgId ?? "pipeline"}
                  className="wizard-catalog__thumb"
                  title={w.title}
                />
                <span className="wizard-catalog__card-text">
                  <strong>{w.title}</strong>
                  <span className="muted">{w.description}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
