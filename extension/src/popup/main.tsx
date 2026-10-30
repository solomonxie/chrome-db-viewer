import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../app/styles/tokens.css";
import "../app/styles/app.css";
import "./popup.css";
import { initTheme } from "../app/lib/theme";
import { Popup } from "./Popup";

initTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Popup />
  </StrictMode>,
);
