/**
 * Our side of the parity checks (REQ-000020-sJpO9KMY Requirement 2): the
 * same fixtures as `cttc.html`, made of our components. `window.parity`
 * lets the test open the dialog and see whether it was told of a close.
 */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Button,
  Dialog,
  Panel,
  SegControl,
  Switch,
} from "../../../renderer/src/components/index.js";
import "../../../renderer/src/theme/tokens.css";
import "../../../renderer/src/theme/cttc.generated.css";
import "../../../renderer/src/icons/icons.css";

/** What the test drives on this page. */
interface Parity {
  openDialog: () => void;
  closes: number;
}

declare global {
  interface Window {
    parity: Parity;
  }
}

const MODES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
] as const;

function Fixtures() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<string>("dark");
  const [statusBar, setStatusBar] = useState(false);
  const [sprockets, setSprockets] = useState(true);
  window.parity.openDialog = () => setOpen(true);
  return (
    <>
      <div className="stage">
        <div className="fixture" data-fixture="button-default">
          <Button>Close</Button>
        </div>
        <div className="fixture" data-fixture="button-primary">
          <Button kind="primary">Save</Button>
        </div>
        <div className="fixture" data-fixture="button-danger">
          <Button kind="danger">Uninstall…</Button>
        </div>
        <div className="fixture" data-fixture="button-disabled">
          <Button disabled>Close</Button>
          <Button kind="danger" disabled>
            Delete
          </Button>
        </div>
        <div className="fixture" data-fixture="button-fetch">
          <Button kind="fetch">Fetch</Button>
        </div>
        <div className="fixture" data-fixture="seg-control">
          <SegControl label="Mode" options={MODES} value={mode} onChange={setMode} />
        </div>
        <div className="fixture" data-fixture="switch">
          <Switch checked={statusBar} onChange={setStatusBar}>
            Show status bar
          </Switch>
          <Switch checked={sprockets} onChange={setSprockets}>
            Sprocket holes
          </Switch>
        </div>
        <div className="fixture sized" data-fixture="panel">
          <Panel title="Logs">2026-11-21 16:00:00 INFO started</Panel>
        </div>
      </div>
      <Dialog
        id="dlg-fixture"
        open={open}
        onClose={() => {
          setOpen(false);
          window.parity.closes += 1;
        }}
        title="Remove Sump"
        actions={
          <>
            <Button>Close</Button>
            <Button kind="danger" disabled>
              Delete
            </Button>
          </>
        }
      >
        <p className="dlg-intro muted">Permanently forgets a saved Sump's connection and key.</p>
      </Dialog>
    </>
  );
}

window.parity = { openDialog: () => {}, closes: 0 };
const root = document.getElementById("root");
if (root) createRoot(root).render(<Fixtures />);
