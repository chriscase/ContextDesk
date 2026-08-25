import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/login.css";
import "./styles/cases.css";
import "./styles/triage-workspace.css";
import "./styles/workstreams.css";
import "./styles/catalog.css";
import "./styles/export.css";
import "./styles/experiment-lab.css";
import "./styles/administration.css";
import "./styles/admin-people.css";
import "./styles/self-profile.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
