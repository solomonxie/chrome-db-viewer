// Entry for media.html: the image/video viewer (design/DESIGN.md §3.12).
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MediaApp } from "./MediaApp";
import "./media.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <MediaApp />
    </StrictMode>,
  );
}
