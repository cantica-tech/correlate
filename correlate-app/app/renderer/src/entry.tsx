/**
 * Renderer entry point: loads the design tokens and mounts the React app into
 * `#root` of `renderer/index.html`. Bundled by `build/build-renderer.js`.
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
createRoot(container).render(<App />);
