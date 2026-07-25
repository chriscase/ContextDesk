import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LogExplorer } from "./components/logExplorer/LogExplorer";
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
import "./styles/components/settings.css";
import "./styles/components/command-palette.css";
import "./styles/components/composition.css";
import "./styles/components/panes.css";
import "./styles/components/session-wizard.css";
import "./styles/components/log-explorer.css";
import "./styles/help.css";

function bootRoot() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("window") === "log-explorer") {
    const corpus = params.get("corpus")?.trim();
    if (corpus) {
      return <LogExplorer corpusId={corpus} />;
    }
  }
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>{bootRoot()}</StrictMode>,
);
