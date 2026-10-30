// Viewer page: shows an image or plays a video that a site sent as a download. The background
// opens it with ?url=, &kind= and &name= (src/preview/media.ts). Download saves the file.

import "../app/styles/tokens.css";
import "../app/styles/app.css";
import "./media.css";
import { initTheme } from "../app/lib/theme";

initTheme();

const params = new URLSearchParams(location.search);
const url = params.get("url") ?? "";
const kind = params.get("kind") === "video" ? "video" : "image";
const name = params.get("name") ?? "";

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

document.title = `${name} · Preview`;
el("name").textContent = name;
el("name").title = url;
const stage = el("stage");
const info = el("info");
const failed = () => {
  el("failed").hidden = false;
};

if (!/^https?:/i.test(url)) {
  failed();
} else if (kind === "video") {
  const video = document.createElement("video");
  video.controls = true;
  video.autoplay = true;
  video.src = url;
  video.addEventListener("loadedmetadata", () => {
    const s = Math.round(video.duration);
    info.textContent = `${video.videoWidth} × ${video.videoHeight} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  });
  video.addEventListener("error", failed);
  stage.append(video);
} else {
  const image = document.createElement("img");
  image.alt = name;
  image.src = url;
  image.addEventListener("load", () => {
    info.textContent = `${image.naturalWidth} × ${image.naturalHeight}`;
    el("fit").hidden = false;
  });
  image.addEventListener("error", failed);
  stage.append(image);
}

// Images bigger than the window are scaled down to fit; this toggles to actual pixels and back.
el("fit").addEventListener("click", () => {
  const actual = stage.classList.toggle("actual");
  el("fit").textContent = actual ? "Fit to window" : "Actual size";
});

// Started by this extension, so the background lets it save. Chrome takes the name from the server as usual.
el("download").addEventListener("click", () => {
  void chrome.downloads.download({ url });
});
