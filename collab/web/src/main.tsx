import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/login.css";
import "./styles/cases.css";
import "./styles/catalog.css";
import "./styles/export.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("missing #root");
}
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
