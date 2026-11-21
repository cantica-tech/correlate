/**
 * Remove Data Stream… (REQ-000027-sJpO9KMY Requirement 4): cttc's
 * `#dlg-remove-daemon` (`index.html:380-391` at d8a444b). Pick a stream over
 * SSH; Delete has the Sump stop its collection and forget it
 * (br-STREAM-000004-sJpO9KMY); its records stay. "Self" is not offered: it is
 * detected, and only closed.
 */
import { useEffect, useState } from "react";
import { Button, Dialog } from "../components/index.js";
import type { ShellBridge } from "../shell/bridge.js";
import { listStreams, removeStream, type Stream } from "./api.js";

/** The dialog's props. */
export interface RemoveDialogProps {
  bridge: ShellBridge;
  open: boolean;
  onClose: () => void;
  /** Called after a removal, for the pill to read the streams again. */
  onRemoved?: () => void;
}

/** The Remove dialog. */
export function RemoveDialog({ bridge, open, onClose, onRemoved }: RemoveDialogProps) {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [chosen, setChosen] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setChosen("");
    setStatus("");
    void listStreams(bridge.sump.request).then((r) => {
      if (r.ok) setStreams(r.value.filter((s) => s.kind === "ssh"));
      else setStatus(r.message);
    });
  }, [open, bridge]);

  const remove = async () => {
    const stream = streams.find((s) => s.id === chosen);
    if (!stream) return;
    setBusy(true);
    const r = await removeStream(bridge.sump.request, stream.id);
    setBusy(false);
    if (!r.ok) return setStatus(r.message);
    void bridge.status.add(`Removed data stream ${stream.label}; its collection stopped`);
    onRemoved?.();
    onClose();
  };

  return (
    <Dialog
      id="dlg-remove-daemon"
      open={open}
      onClose={onClose}
      title="Remove Data Stream"
      actions={
        <>
          <Button
            id="dlg-remove-daemon-close"
            title="Close without removing anything"
            onClick={onClose}
          >
            Close
          </Button>
          <Button
            id="dlg-remove-daemon-delete"
            kind="danger"
            disabled={!chosen || busy}
            title="Stop collecting this data stream and forget it"
            onClick={() => void remove()}
          >
            Delete
          </Button>
        </>
      }
    >
      <p className="dlg-intro muted">
        Stops collecting a data stream and forgets it: its connection, its selection and its host
        key. Its records stay. Close Data Streams keeps it; this doesn't.
      </p>
      <label className="ctl block">
        Saved data streams
        <select
          id="remove-daemon-select"
          value={chosen}
          onChange={(e) => setChosen(e.currentTarget.value)}
        >
          <option value="">— pick a data stream to remove —</option>
          {streams.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div id="remove-daemon-status" className="muted">
        {status}
      </div>
    </Dialog>
  );
}
