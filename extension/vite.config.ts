import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Plain multi-page build. public/manifest.json is copied as is, so the output in dist/
// loads unpacked from chrome://extensions with no extra plugin.
const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@core": resolve(__dirname, "src/core") } },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome120",
    rollupOptions: {
      input: {
        app: resolve(__dirname, "app.html"),
        popup: resolve(__dirname, "popup.html"),
        media: resolve(__dirname, "media.html"),
        sandbox: resolve(__dirname, "sandbox.html"),
        background: resolve(__dirname, "src/background/index.ts"),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === "background" ? "background.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  test: { environment: "jsdom" },
});
