/**
 * Our side of the Opened Data dialog's parity check (REQ-000034-sJpO9KMY
 * Requirement 4): our OpenedData, open, on the parity files; `?empty` with
 * none.
 */
import { createRoot } from "react-dom/client";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/theme/cttc.generated.css";
import { OpenedData } from "../../../renderer/src/shell/OpenedData.js";
import { OPENED_FILES } from "../openedData.js";

const empty = location.search.includes("empty");
const none = () => {};
const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <OpenedData
      open
      list={empty ? { files: [], active: null } : OPENED_FILES}
      onSwitch={none}
      onRemove={none}
      onClose={none}
    />,
  );
