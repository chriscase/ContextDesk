import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { EngineeringHandbook } from "./components/handbook";
import { LogExplorer } from "./components/logExplorer/LogExplorer";
import { parseExplorerBoot } from "./lib/logExplorer/boot";
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

function bootRoot() {
  const boot = parseExplorerBoot(window.location.search, window.location.hash);
  if (boot.mode === "explorer") {
    if (!boot.corpusId) {
      return (
        <ExplorerBootError reason="Missing corpus id in window URL (expected ?window=log-explorer&corpus=…)." />
      );
    }
    return <LogExplorer corpusId={boot.corpusId} />;
  }
  if (boot.mode === "handbook") {
    return <EngineeringHandbook />;
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{bootRoot()}</StrictMode>,
);
