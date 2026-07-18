import type { DefaultWorkspaceDto } from "../../lib/host";
import type { PreflightItem, PreflightReport } from "../../lib/preflight";
import { PreflightPanel } from "../PreflightPanel";

export type PreflightSectionProps = {
  report: PreflightReport;
  onRecheck: () => void;
  onFix: (section: NonNullable<PreflightItem["fixAction"]>) => void;
  checking: boolean;
  defaultWorkspace: DefaultWorkspaceDto | null;
  defaultWorkspaceBusy: boolean;
  onUseDefaultWorkspace: () => void;
};

export function PreflightSection({
  report,
  onRecheck,
  onFix,
  checking,
  defaultWorkspace,
  defaultWorkspaceBusy,
  onUseDefaultWorkspace,
}: PreflightSectionProps) {
  return (
    <PreflightPanel
      report={report}
      onRecheck={onRecheck}
      onFix={onFix}
      checking={checking}
      defaultWorkspace={defaultWorkspace}
      defaultWorkspaceBusy={defaultWorkspaceBusy}
      onUseDefaultWorkspace={onUseDefaultWorkspace}
    />
  );
}
