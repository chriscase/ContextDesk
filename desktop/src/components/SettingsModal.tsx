/**
 * Settings shell (#147): routes NAV sections, owns draft/dirty/save via controller.
 * Section UI lives under `./settings/*`.
 */
import type { ReactNode } from "react";
import type { AppSetupState, PreflightReport } from "../lib/preflight";
import { AppearanceSection } from "./settings/AppearanceSection";
import { AiSection } from "./settings/AiSection";
import { ConnectorsSection } from "./settings/ConnectorsSection";
import { GeneralSection } from "./settings/GeneralSection";
import { PreflightSection } from "./settings/PreflightSection";
import { WorkspaceSection } from "./settings/WorkspaceSection";
import {
  useSettingsController,
  type SettingsSection,
} from "./settings/useSettingsController";
import {
  IconAi,
  IconAppearance,
  IconClose,
  IconConnectors,
  IconPreflight,
  IconSliders,
  IconWorkspace,
} from "./icons";

export type { SettingsSection };

type Props = {
  open: boolean;
  initialSection?: SettingsSection;
  setup: AppSetupState;
  theme: "dark" | "light";
  onThemeChange: (t: "dark" | "light") => void;
  /** Type scale multiplier (#151). */
  uiScale?: "90" | "100" | "110";
  onUiScaleChange?: (s: "90" | "100" | "110") => void;
  onClose: () => void;
  onSaveSetup: (next: AppSetupState) => void;
  onRecheckHost?: () => void | Promise<void>;
  hostReport?: PreflightReport | null;
};

const NAV: { id: SettingsSection; label: string; icon: ReactNode }[] = [
  { id: "preflight", label: "Preflight", icon: <IconPreflight /> },
  { id: "workspace", label: "Workspace", icon: <IconWorkspace /> },
  { id: "ai", label: "AI / Models", icon: <IconAi /> },
  { id: "connectors", label: "Connectors", icon: <IconConnectors /> },
  { id: "appearance", label: "Appearance", icon: <IconAppearance /> },
  { id: "general", label: "General", icon: <IconSliders /> },
];

export function SettingsModal({
  open,
  initialSection = "preflight",
  setup,
  theme,
  onThemeChange,
  uiScale = "100",
  onUiScaleChange,
  onClose,
  onSaveSetup,
  onRecheckHost,
  hostReport,
}: Props) {
  const c = useSettingsController({
    open,
    initialSection,
    setup,
    onClose,
    onSaveSetup,
    onRecheckHost,
    hostReport,
  });

  // Hooks run even when closed (controller); no section UI when closed.
  if (!open) return null;

  return (
    <div className="settings-page" role="region" aria-label="Settings">
      <div className="settings-panel settings-panel--page">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav__title">Settings</div>
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className="settings-nav__item"
              data-active={c.section === item.id ? "true" : "false"}
              onClick={() => c.setSection(item.id)}
            >
              <span className="settings-nav__icon" aria-hidden>
                {item.icon}
              </span>
              <span className="settings-nav__label">{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="settings-body">
          <header className="settings-header">
            <div className="settings-header__title">
              {NAV.find((n) => n.id === c.section)?.label}
            </div>
            <button
              type="button"
              className="icon-btn"
              onClick={c.requestClose}
              title="Close"
            >
              <IconClose />
            </button>
          </header>
          <div className="settings-content">
            {c.section === "preflight" ? (
              <PreflightSection
                report={c.report}
                onRecheck={c.recheck}
                onFix={c.fix}
                checking={c.checking}
                defaultWorkspace={c.defaultWs}
                defaultWorkspaceBusy={c.defaultWsBusy}
                onUseDefaultWorkspace={() =>
                  void c.applyDefaultWorkspace({ persist: true })
                }
              />
            ) : null}

            {c.section === "workspace" ? (
              <WorkspaceSection
                baseId={c.baseId}
                draft={c.draft}
                setDraft={c.setDraft}
                defaultWs={c.defaultWs}
                defaultWsBusy={c.defaultWsBusy}
                addRoot={c.addRoot}
                applyDefaultWorkspace={c.applyDefaultWorkspace}
              />
            ) : null}

            {c.section === "ai" ? (
              <AiSection
                baseId={c.baseId}
                draft={c.draft}
                setDraft={c.setDraft}
                candidates={c.candidates}
                apiKeyDraft={c.apiKeyDraft}
                setApiKeyDraft={c.setApiKeyDraft}
                probeNote={c.probeNote}
                remoteUrlCheck={c.remoteUrlCheck}
                urlError={c.urlError}
                recheck={c.recheck}
                checking={c.checking}
              />
            ) : null}

            {c.section === "connectors" ? (
              <ConnectorsSection
                baseId={c.baseId}
                draft={c.draft}
                setDraft={c.setDraft}
                newsSources={c.newsSources}
                setNewsSources={c.setNewsSources}
                newsByGroup={c.newsByGroup}
                setSourceEnabled={c.setSourceEnabled}
                setGroupEnabled={c.setGroupEnabled}
                connectors={c.connectors}
                setConnectors={c.setConnectors}
                connectorKinds={c.connectorKinds}
                newConnectorKind={c.newConnectorKind}
                setNewConnectorKind={c.setNewConnectorKind}
                connectorsNote={c.connectorsNote}
                pgPasswordDrafts={c.pgPasswordDrafts}
                setPgPasswordDrafts={c.setPgPasswordDrafts}
                httpBearerDrafts={c.httpBearerDrafts}
                setHttpBearerDrafts={c.setHttpBearerDrafts}
                cfTokenDraft={c.cfTokenDraft}
                setCfTokenDraft={c.setCfTokenDraft}
                cfStatus={c.cfStatus}
                setCfStatus={c.setCfStatus}
                confluenceUrlError={c.confluenceUrlError}
                xTokenDraft={c.xTokenDraft}
                setXTokenDraft={c.setXTokenDraft}
                xStatus={c.xStatus}
                setXStatus={c.setXStatus}
              />
            ) : null}

            {c.section === "appearance" ? (
              <AppearanceSection
                baseId={c.baseId}
                theme={theme}
                onThemeChange={onThemeChange}
                uiScale={uiScale}
                onUiScaleChange={onUiScaleChange}
              />
            ) : null}

            {c.section === "general" ? (
              <GeneralSection
                baseId={c.baseId}
                draft={c.draft}
                routerBudget={c.routerBudget}
                setRouterBudget={c.setRouterBudget}
              />
            ) : null}
          </div>
          <footer className="settings-footer">
            <button
              type="button"
              className="btn btn--ghost"
              onClick={c.requestClose}
            >
              Cancel{c.dirty ? " (unsaved)" : ""}
            </button>
            <button type="button" className="btn btn--primary" onClick={c.save}>
              Save
            </button>
          </footer>
        </div>
      </div>
    </div>
  );
}
