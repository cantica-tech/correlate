/**
 * Our side of the menu bar parity check (REQ-000023-sJpO9KMY Requirement
 * 5): our MenuBar, shortcuts shown as on macOS; the test opens each menu by
 * clicking its label.
 */
import { createRoot } from "react-dom/client";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/theme/cttc.generated.css";
import { MenuBar } from "../../../renderer/src/menubar/MenuBar.js";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <div id="stage">
      <MenuBar onAction={() => {}} mac />
    </div>,
  );
}
