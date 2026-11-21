/**
 * Renderer entry point: loads the design tokens and mounts the shell into
 * `#root` of `renderer/index.html`; with `?view=sidebar`, the detached
 * sidebar's window (REQ-000021-sJpO9KMY). Bundled by
 * `build/build-renderer.js`.
 */
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
// cttc's design tokens and base type (br-STYLE-000001-sJpO9KMY), bundled into
// renderer/dist/bundle.css.
import "./theme/tokens.css";

const container = document.getElementById("root");
if (!container) {
  throw new Error("renderer/index.html is missing #root");
}
const view = new URLSearchParams(window.location.search).get("view");
createRoot(container).render(<App detached={view === "sidebar"} />);
