import type { DefaultWorkspaceDto } from "../../lib/host";
import type { AppSetupState } from "../../lib/preflight";
import { TextField } from "../forms";

export type WorkspaceSectionProps = {
  baseId: string;
  draft: AppSetupState;
  setDraft: React.Dispatch<React.SetStateAction<AppSetupState>>;
  defaultWs: DefaultWorkspaceDto | null;
  defaultWsBusy: boolean;
  addRoot: () => void | Promise<void>;
  applyDefaultWorkspace: (opts: { persist: boolean }) => void | Promise<void>;
};

export function WorkspaceSection({
  baseId,
  draft,
  setDraft,
  defaultWs,
  defaultWsBusy,
  addRoot,
  applyDefaultWorkspace,
}: WorkspaceSectionProps) {
  return (
<div>
  <p className="section-lead">
    Choose folders ContextDesk may search. Nothing is indexed
    outside these roots. Prefer the picker over editing JSON.
  </p>
  <TextField
    id={`${baseId}-ws-name`}
    label="Workspace name"
    value={draft.workspaceName ?? ""}
    onChange={(e) =>
      setDraft((d) => ({
        ...d,
        workspaceName: e.target.value || null,
      }))
    }
    placeholder="My project"
  />
  <div className="field">
    <span className="field__label">Allowlisted roots</span>
    {draft.workspaceRoots.length === 0 ? (
      <span className="field__error">Add at least one folder.</span>
    ) : (
      <ul className="session-list">
        {draft.workspaceRoots.map((r) => (
          <li key={r}>
            <div className="session-list__item row--between">
              <span className="mono mono--sm">
                {r}
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() =>
                  setDraft((d) => ({
                    ...d,
                    workspaceRoots: d.workspaceRoots.filter((x) => x !== r),
                  }))
                }
              >
                Remove
              </button>
            </div>
          </li>
        ))}
      </ul>
    )}
    <div className="workspace-root-actions">
      <button
        type="button"
        className="btn btn--primary"
        onClick={() => void addRoot()}
      >
        Add folder…
      </button>
      <button
        type="button"
        className="btn btn--ghost"
        disabled={defaultWsBusy}
        onClick={() => void applyDefaultWorkspace({ persist: false })}
        title={
          defaultWs
            ? `Create or use ${defaultWs.path}`
            : "Use the platform Documents folder (desktop app)"
        }
      >
        {defaultWsBusy
          ? "Setting default…"
          : defaultWs
            ? `Use default (${defaultWs.label})`
            : "Use default folder"}
      </button>
    </div>
    {defaultWs ? (
      <p className="field__hint">
        Default on this OS:{" "}
        <span className="mono mono--sm">{defaultWs.path}</span>
        {defaultWs.exists ? " (exists)" : " (will be created)"}
        . Never uses your whole home directory.
      </p>
    ) : (
      <p className="field__hint">
        In the desktop app, one click sets a Documents/ContextDesk
        folder (macOS, Windows, and Linux).
      </p>
    )}
  </div>
</div>

  );
}
