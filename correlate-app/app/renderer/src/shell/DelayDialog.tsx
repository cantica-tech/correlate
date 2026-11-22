/**
 * A track's delay (REQ-000035-sJpO9KMY Requirement 5): seconds, signed, at
 * most a day either way, shifting its data in the analysis view to line up
 * captures whose clocks differ. Kept in the project.
 */
import { useState } from "react";
import { Button, Dialog } from "../components/index.js";

/** A delay is at most a day either way (the main process clamps it too). */
const MAX = 86_400;

/** The dialog's props. */
export interface DelayDialogProps {
  delaying: { name: string; secs: number } | null;
  onSet: (name: string, secs: number) => void;
  onClose: () => void;
}

/** The dialog. */
export function DelayDialog({ delaying, onSet, onClose }: DelayDialogProps) {
  const [value, setValue] = useState("");
  const [shownFor, setShownFor] = useState<DelayDialogProps["delaying"]>(null);
  if (delaying !== shownFor) {
    setShownFor(delaying);
    setValue(String(delaying?.secs ?? 0));
  }
  const secs = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(secs) && Math.abs(secs) <= MAX;
  const done = () => {
    if (!delaying || !valid) return;
    onSet(delaying.name, secs);
    onClose();
  };
  return (
    <Dialog
      id="dlg-track-delay"
      open={delaying !== null}
      onClose={onClose}
      title={`Delay of ${delaying?.name ?? ""}`}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!valid} onClick={done}>
            Set
          </Button>
        </>
      }
    >
      <p className="dlg-section-help muted">
        Shifts this track's data by this many seconds in the analysis view, later when positive,
        earlier when negative, to line up captures taken on clocks that differ. Kept in the project.
      </p>
      <label className="ctl">
        <input
          type="number"
          step="any"
          min={-MAX}
          max={MAX}
          aria-label="Delay, in seconds"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") done();
          }}
        />{" "}
        s
      </label>
    </Dialog>
  );
}
