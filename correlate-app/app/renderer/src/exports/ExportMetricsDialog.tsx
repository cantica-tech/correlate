/**
 * cttc's Export metrics dialog (`#dlg-export-metrics`, `index.html:817-852`,
 * `app.js:1600-1800`; REQ-000042-sJpO9KMY Requirement 1,
 * br-EXPORT-000005-sJpO9KMY): step 1, what to include; step 2, the format and
 * the stats' detail; then Export…, which asks where to save before anything
 * is built (br-EXPORT-000002-sJpO9KMY). It closes once the file is written.
 */
import { useEffect, useState } from "react";
import { Button, Dialog } from "../components/index.js";

/** What the dialog asks the main process to export. */
export interface MetricsChoice {
  stats: boolean;
  logs: boolean;
  format: "text" | "json";
  detail: "summary" | "full";
}

/** The dialog's props. */
export interface ExportMetricsDialogProps {
  open: boolean;
  /** Export as chosen: true once written (the dialog closes), false otherwise. */
  onExport: (choice: MetricsChoice) => Promise<boolean>;
  onClose: () => void;
}

/** The dialog. */
export function ExportMetricsDialog({ open, onExport, onClose }: ExportMetricsDialogProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [stats, setStats] = useState(true);
  const [logs, setLogs] = useState(true);
  const [format, setFormat] = useState<MetricsChoice["format"]>("text");
  const [detail, setDetail] = useState<MetricsChoice["detail"]>("summary");
  const [busy, setBusy] = useState(false);

  // Each opening starts at step 1, as cttc's button does; the choices stay.
  useEffect(() => {
    if (open) setStep(1);
  }, [open]);

  const exportNow = async () => {
    setBusy(true);
    try {
      if (await onExport({ stats, logs, format, detail })) onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog id="dlg-export-metrics" open={open} onClose={onClose} title="Export metrics">
      <div id="export-metrics-step1" hidden={step !== 1}>
        <p className="dlg-intro muted">
          Export the active metrics file's data as a plain-text or JSON file, covering its whole
          time range.
        </p>
        <label className="ctl block">
          <input
            id="export-metrics-stats"
            type="checkbox"
            checked={stats}
            onChange={(e) => setStats(e.currentTarget.checked)}
          />
          Stats (CPU/MEM/NET telemetry)
        </label>
        <label className="ctl block">
          <input
            id="export-metrics-logs"
            type="checkbox"
            checked={logs}
            onChange={(e) => setLogs(e.currentTarget.checked)}
          />
          Logs
        </label>
        <div className="dlg-actions">
          <Button id="dlg-export-metrics-cancel" title="Close without exporting" onClick={onClose}>
            Cancel
          </Button>
          <Button
            id="dlg-export-metrics-next"
            kind="primary"
            title="Choose the export format"
            disabled={!stats && !logs}
            onClick={() => setStep(2)}
          >
            Next…
          </Button>
        </div>
      </div>
      <div id="export-metrics-step2" hidden={step !== 2}>
        <div className="dlg-section-help muted">Format</div>
        <div className="btn-group" id="export-metrics-format-switch">
          <Button
            id="export-metrics-format-text"
            kind={format === "text" ? "primary" : "default"}
            title="A human-readable plain-text file"
            onClick={() => setFormat("text")}
          >
            Text
          </Button>
          <Button
            id="export-metrics-format-json"
            kind={format === "json" ? "primary" : "default"}
            title="A machine-readable JSON file"
            onClick={() => setFormat("json")}
          >
            JSON
          </Button>
        </div>
        <div id="export-metrics-granularity-row" hidden={!stats}>
          <div className="dlg-section-help muted">Stats detail</div>
          <div className="btn-group" id="export-metrics-granularity-switch">
            <Button
              id="export-metrics-granularity-summary"
              kind={detail === "summary" ? "primary" : "default"}
              title="Per container: first/last/min/max/mean CPU/MEM/NET over the whole file"
              onClick={() => setDetail("summary")}
            >
              Summary
            </Button>
            <Button
              id="export-metrics-granularity-full"
              kind={detail === "full" ? "primary" : "default"}
              title="Every recorded sample, per container"
              onClick={() => setDetail("full")}
            >
              Full time series
            </Button>
          </div>
        </div>
        <div className="dlg-actions">
          <Button
            id="dlg-export-metrics-back"
            title="Back to what to include"
            onClick={() => setStep(1)}
          >
            Back
          </Button>
          <Button
            id="dlg-export-metrics-export"
            kind="primary"
            title="Save the export"
            disabled={busy}
            onClick={() => void exportNow()}
          >
            💾 Export…
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
