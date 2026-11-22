/**
 * cttc's snapshot dialog (`#dlg-snapshot`, `index.html:731-761`,
 * `renderSnapshot` `app.js:1457`; REQ-000041-sJpO9KMY Requirement 3,
 * br-EXPORT-000004-sJpO9KMY): the shown containers' and host's values at a
 * time and, optionally, the log lines around it and a panorama; read as a
 * table or as JSON, saved as `.txt` or `.json` where the user chooses.
 */
import { Fragment, useEffect, useState } from "react";
import { Button, Dialog } from "../components/index.js";
import { clock } from "../logs/api.js";
import {
  cell,
  fmtIso,
  panoramaWords,
  type Snapshot,
  type SnapshotOptions,
  snapshotName,
  snapshotToText,
} from "./snapshot.js";

/** The dialog's props. */
export interface SnapshotDialogProps {
  /** The time the snapshot is at, or null when closed. */
  at: number | null;
  /** Take the snapshot at `t` with these options. */
  take: (t: number, options: SnapshotOptions) => Promise<Snapshot>;
  /** Save the shown snapshot's text: the destination is asked there. */
  save: (snapshot: { name: string; content: string; kind: "txt" | "json" }) => void;
  onClose: () => void;
}

/** cttc's defaults: logs on, panorama off at 3 entries. */
const DEFAULTS: SnapshotOptions = {
  includeLogs: true,
  panoramaOn: false,
  panoramaUnit: "entries",
  panoramaValue: 3,
};

/** The snapshot dialog. */
export function SnapshotDialog({ at, take, save, onClose }: SnapshotDialogProps) {
  const [options, setOptions] = useState<SnapshotOptions>(DEFAULTS);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [json, setJson] = useState(false);

  // Taken again whenever the time or an option changes, as cttc's refreshSnapshot.
  useEffect(() => {
    if (at === null) return;
    let live = true;
    setSnap(null);
    setFailed(null);
    take(at, options).then(
      (s) => live && setSnap(s),
      (e: unknown) => live && setFailed((e as Error).message),
    );
    return () => {
      live = false;
    };
  }, [at, options, take]);

  // A new snapshot opens on the table, as cttc's.
  useEffect(() => {
    if (at !== null) setJson(false);
  }, [at]);

  const set = (change: Partial<SnapshotOptions>) => setOptions((o) => ({ ...o, ...change }));
  const series = snap?.slices[0]?.services.length ?? 0;
  const rows = snap?.slices.reduce(
    (n, sl) => n + sl.logs.reduce((m, l) => m + l.rows.length, 0),
    0,
  );
  const meta = failed
    ? `snapshot failed: ${failed}`
    : snap
      ? `t = ${fmtIso(snap.t)}${panoramaWords(snap) ? ` · ${panoramaWords(snap)}` : ""} · ${series} series · ${rows} log entries`
      : "loading…";

  return (
    <Dialog
      id="dlg-snapshot"
      open={at !== null}
      onClose={onClose}
      title="Snapshot"
      actions={
        <>
          <Button id="dlg-snapshot-close" title="Close this snapshot" onClick={onClose}>
            Close
          </Button>
          <Button
            id="dlg-snapshot-save-txt"
            title="Save this snapshot as a plain-text file"
            hidden={json}
            disabled={!snap}
            onClick={() =>
              snap &&
              save({
                name: snapshotName(snap.t, "txt"),
                content: snapshotToText(snap),
                kind: "txt",
              })
            }
          >
            💾 Save as TXT…
          </Button>
          <Button
            id="dlg-snapshot-save"
            kind="primary"
            title="Save this snapshot as a JSON file"
            hidden={!json}
            disabled={!snap}
            onClick={() =>
              snap &&
              save({
                name: snapshotName(snap.t, "json"),
                content: JSON.stringify(snap, null, 2),
                kind: "json",
              })
            }
          >
            💾 Save as JSON…
          </Button>
        </>
      }
    >
      <div id="snapshot-meta" className="muted">
        {meta}
      </div>
      <label className="ctl">
        <input
          id="snap-logs"
          type="checkbox"
          checked={options.includeLogs}
          onChange={(e) => set({ includeLogs: e.currentTarget.checked })}
        />
        Include nearby log entries
      </label>{" "}
      {/* cttc's markup by hand: its text and fields sit in the switch row itself. */}
      <label
        className="ctl switch-row"
        title="Enlarge the snapshot around the selected time: widen the log context by N entries, or add extra telemetry/log slices N seconds before and after"
      >
        <span className="switch">
          <input
            id="snap-panorama-on"
            type="checkbox"
            role="switch"
            aria-checked={options.panoramaOn}
            checked={options.panoramaOn}
            onChange={(e) => set({ panoramaOn: e.currentTarget.checked })}
          />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
        </span>
        panorama
        <input
          id="snap-panorama-value"
          type="number"
          min="0"
          step="1"
          value={options.panoramaValue}
          disabled={!options.panoramaOn}
          onChange={(e) => set({ panoramaValue: Math.max(0, Number(e.currentTarget.value) || 0) })}
        />
        <select
          id="snap-panorama-unit"
          value={options.panoramaUnit}
          disabled={!options.panoramaOn}
          onChange={(e) =>
            set({ panoramaUnit: e.currentTarget.value === "seconds" ? "seconds" : "entries" })
          }
        >
          <option value="entries">entries</option>
          <option value="seconds">seconds</option>
        </select>
      </label>{" "}
      <div className="btn-group" id="snapshot-view-switch">
        <Button
          id="snap-view-raw"
          kind={json ? "default" : "primary"}
          title="Show a human-readable table"
          onClick={() => setJson(false)}
        >
          Raw
        </Button>
        <Button
          id="snap-view-json"
          kind={json ? "primary" : "default"}
          title="Show the raw JSON payload"
          onClick={() => setJson(true)}
        >
          JSON
        </Button>
      </div>
      <div id="snapshot-props" className="snapshot-body" hidden={json}>
        {snap?.slices.map((slice) => (
          <SliceView key={slice.label} slice={slice} headed={snap.slices.length > 1} />
        ))}
      </div>
      <pre id="snapshot-json" className="snapshot-body" hidden={!json}>
        {snap ? JSON.stringify(snap, null, 2) : ""}
      </pre>
    </Dialog>
  );
}

/** One slice: its head when there are several, its table, its log lines. */
function SliceView({ slice, headed }: { slice: Snapshot["slices"][number]; headed: boolean }) {
  return (
    <>
      {headed ? (
        <div className="snapshot-slice-head">
          {slice.label} — {fmtIso(slice.t)}
        </div>
      ) : null}
      <table className="snapshot-table">
        <tbody>
          <tr>
            <th>source</th>
            <th>cpu</th>
            <th>mem</th>
            <th>net</th>
            <th>at</th>
          </tr>
          {slice.services.map((s) => (
            <tr key={`${s.host}:${s.name}`}>
              <td>
                {s.host ? "\u{1F5A5} " : ""}
                {s.name}
              </td>
              <td>{cell(s, "cpu", "–")}</td>
              <td>{cell(s, "mem", "–")}</td>
              <td>{cell(s, "net", "–")}</td>
              <td>{cell(s, "ts", "–")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {slice.logs.map((l) => (
        <Fragment key={l.source}>
          <div className="snapshot-log-head">{l.source}</div>
          {l.rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are a fixed list for this slice.
            <div className="snapshot-log-row" key={i}>
              {`${clock(r.ts)}  ${r.text.split("\n")[0]}`}
            </div>
          ))}
        </Fragment>
      ))}
    </>
  );
}
