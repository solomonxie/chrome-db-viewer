import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/tokens.css";
import "./styles/app.css";
import { App } from "./App";
import { installReservedKeyGuard } from "./lib/keys";
import { initTheme } from "./lib/theme";

initTheme();
installReservedKeyGuard();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
