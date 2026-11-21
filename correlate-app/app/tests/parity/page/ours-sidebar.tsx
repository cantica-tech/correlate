/**
 * Our side of the sidebar parity check (REQ-000021-sJpO9KMY Requirement 5):
 * the sidebar for the case named in `?case=`, in the app body as the shell
 * draws it, or alone as in the detached window.
 */
import { createRoot } from "react-dom/client";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/components/components.css";
import "../../../renderer/src/shell/shell.css";
import { Sidebar } from "../../../renderer/src/shell/Sidebar.js";
import { SIDEBAR_CASES } from "./sidebar-cases.js";

const name = new URLSearchParams(window.location.search).get("case") ?? "open";
const found = SIDEBAR_CASES[name];
const root = document.getElementById("root");
if (root && found) {
  const noop = () => {};
  const sidebar = (
    <Sidebar layout={found.layout} detached={found.detached} onChange={noop} onAction={noop} />
  );
  createRoot(root).render(
    found.detached ? (
      <div id="stage" className="detached">
        {sidebar}
      </div>
    ) : (
      <div id="stage">
        <div id="app-body" data-dock={found.layout.dock}>
          {sidebar}
          <div id="action-bar-splitter" />
          <div id="main-content" />
        </div>
      </div>
    ),
  );
}
