import type { RouterBudgetDto } from "../../lib/host";
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
