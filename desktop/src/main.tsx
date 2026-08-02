import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EngineeringHandbook } from "./components/handbook";
import { LogExplorer } from "./components/logExplorer/LogExplorer";
import { parseExplorerBoot } from "./lib/logExplorer/boot";
import {
  applyUiScaleToDocument,
  subscribeUiScaleChanges,
  UI_SCALE_STORAGE_KEY,
} from "./lib/uiScaleBridge";
import "./assets/fonts/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/themes/dark.css";
import "./styles/themes/light.css";
import "./styles/themes/slate.css";
import "./styles/themes/sand.css";
import "./styles/themes/forest.css";
import "./styles/layout.css";
import "./styles/components/composer.css";
import "./styles/components/tools.css";
import "./styles/components/chat.css";
import "./styles/components/forms.css";
import "./styles/components/help-tip.css";
import "./styles/components/theme-picker.css";
import "./styles/components/settings.css";
import "./styles/components/command-palette.css";
import "./styles/components/composition.css";
import "./styles/components/panes.css";
import "./styles/components/session-wizard.css";
import "./styles/components/log-explorer.css";
import "./styles/components/import-flow.css";
import "./styles/components/investigation-report.css";
import "./styles/help.css";

function ExplorerBootError({ reason }: { reason: string }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        margin: 0,
        padding: "2rem",
        background: "#0b0c0e",
        color: "#e8eaed",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "1.1rem" }}>Log Explorer failed to open</h1>
      <p style={{ color: "#9aa0a6" }}>{reason}</p>
      <p style={{ color: "#9aa0a6", fontSize: "0.85rem" }}>
        Close this window and use <strong>Open Explorer…</strong> from the Logs
        library, or restart ContextDesk.
      </p>
      <pre style={{ fontSize: "0.75rem", opacity: 0.7 }}>
        {typeof window !== "undefined" ? window.location.href : ""}
      </pre>
    </div>
  );
}

/**
 * Dedicated windows render without <App>/useShellState, so the Appearance UI
 * scale (html[data-ui-scale] → base.css font-size) must be applied and kept
 * in live sync here (#641). Subscription is window-lifetime by design — the
 * webview and its listeners are torn down together when the window closes.
 */
function bootDedicatedWindowUiScale() {
  try {
    applyUiScaleToDocument(localStorage.getItem(UI_SCALE_STORAGE_KEY));
  } catch {
    applyUiScaleToDocument("100");
  }
  subscribeUiScaleChanges((scale) => applyUiScaleToDocument(scale));
}

/**
 * Corpus-first document title mirroring the native window title (#641).
 * The display name arrives in the boot URL (set by the Rust window opener,
 * which owns the authoritative name) so no host round-trip is needed here —
 * the boundary ratchet keeps main.tsx off `lib/host`. Corpus id stands in
 * when the name param is absent (hash-fallback boots).
 */
function applyExplorerWindowTitle(corpusId: string, corpusName: string | null) {
  document.title = `${corpusName ?? corpusId} — Log Explorer`;
}

function bootRoot() {
  const boot = parseExplorerBoot(window.location.search, window.location.hash);
  if (boot.mode === "explorer") {
    bootDedicatedWindowUiScale();
    if (!boot.corpusId) {
      return (
        <ExplorerBootError reason="Missing corpus id in window URL (expected ?window=log-explorer&corpus=…)." />
      );
    }
    applyExplorerWindowTitle(boot.corpusId, boot.corpusName);
    return <LogExplorer corpusId={boot.corpusId} />;
  }
  if (boot.mode === "handbook") {
    bootDedicatedWindowUiScale();
    return <EngineeringHandbook />;
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{bootRoot()}</StrictMode>,
);
