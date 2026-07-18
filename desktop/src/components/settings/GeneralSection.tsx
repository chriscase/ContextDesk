import { useState } from "react";
import {
  hostCheckForUpdates,
  hostInstallUpdate,
  type RouterBudgetDto,
} from "../../lib/host";
import type { AppSetupState } from "../../lib/preflight";
import { TextField } from "../forms";

export type GeneralSectionProps = {
  baseId: string;
  draft: AppSetupState;
  routerBudget: RouterBudgetDto;
  setRouterBudget: React.Dispatch<React.SetStateAction<RouterBudgetDto>>;
};

export function GeneralSection({
  baseId,
  draft,
  routerBudget,
  setRouterBudget,
}: GeneralSectionProps) {
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);

  const onCheckUpdates = async () => {
    setUpdateBusy(true);
    setUpdateNote(null);
    try {
      const result = await hostCheckForUpdates();
      if (!result.available) {
        setUpdateNote(
          result.currentVersion === "browser"
            ? "Updates require the desktop app (Tauri)."
            : `You're on ${result.currentVersion}. No update found.`,
        );
        return;
      }
      const { dialogConfirm } = await import("../../lib/dialogs");
      const ok = await dialogConfirm(
        `Version ${result.version} is available (you have ${result.currentVersion}). Download and install now? The app will restart after install.`,
        { title: "Update available", kind: "info" },
      );
      if (!ok) {
        setUpdateNote(`Update ${result.version} available — install cancelled.`);
        return;
      }
      setUpdateNote(`Downloading ${result.version}…`);
      await hostInstallUpdate();
      setUpdateNote("Update installed. Restart if the app did not relaunch.");
    } catch (e) {
      setUpdateNote(
        e instanceof Error ? e.message : "Could not check for updates",
      );
    } finally {
      setUpdateBusy(false);
    }
  };

  return (
    <div>
      <p className="section-lead">
        ContextDesk is configured through this UI. Config on disk is an
        implementation detail — not the workflow.
      </p>
      <p className="section-lead">
        Data directory status:{" "}
        {draft.dataDirWritable ? "writable" : "not writable"}.
      </p>
      <h3 className="settings-connector-block__title">Updates</h3>
      <p className="field__hint">
        Opt-in signed channel (#173). Checks only when you click; nothing
        installs without confirmation. Private signing key is never in the
        app or repo.
      </p>
      <div className="workspace-root-actions">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={updateBusy}
          onClick={() => void onCheckUpdates()}
        >
          {updateBusy ? "Checking…" : "Check for updates"}
        </button>
      </div>
      {updateNote ? <p className="field__hint">{updateNote}</p> : null}
      <h3 className="settings-connector-block__title">Retrieval budgets</h3>
      <p className="field__hint">
        Enforced on the agent loop and search_kb. Reflected in the search trail
        as{" "}
        <code>budget:sources=…,rounds=…,per_source=…,deadline=…ms</code>.
      </p>
      <TextField
        id={`${baseId}-rounds`}
        label="Max tool rounds"
        hint="1–32. Loop stops with reason budget_rounds."
        value={String(routerBudget.max_tool_rounds)}
        onChange={(e) =>
          setRouterBudget((b) => ({
            ...b,
            max_tool_rounds: Number(e.target.value) || 1,
          }))
        }
      />
      <TextField
        id={`${baseId}-per-source`}
        label="Max results per source"
        hint="Caps search_kb limit (smaller of tool arg and this)."
        value={String(routerBudget.max_results_per_source)}
        onChange={(e) =>
          setRouterBudget((b) => ({
            ...b,
            max_results_per_source: Number(e.target.value) || 1,
          }))
        }
      />
      <TextField
        id={`${baseId}-sources`}
        label="Max ranked sources"
        hint="How many sources rank_sources may fan out."
        value={String(routerBudget.max_sources)}
        onChange={(e) =>
          setRouterBudget((b) => ({
            ...b,
            max_sources: Number(e.target.value) || 1,
          }))
        }
      />
      <TextField
        id={`${baseId}-deadline`}
        label="Deadline (ms)"
        hint="Wall-clock stop; TurnCompleted reason budget_time."
        value={String(routerBudget.deadline_ms)}
        onChange={(e) =>
          setRouterBudget((b) => ({
            ...b,
            deadline_ms: Number(e.target.value) || 500,
          }))
        }
      />
    </div>
  );
}
