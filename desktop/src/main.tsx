import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/themes/dark.css";
import "./styles/themes/light.css";
import "./styles/layout.css";
import "./styles/components/composer.css";
import "./styles/components/tools.css";
import "./styles/components/chat.css";
import "./styles/components/forms.css";
import "./styles/components/settings.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
