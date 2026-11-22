/**
 * cttc's Create Event / Edit Event dialog (`#dlg-event-form`,
 * `index.html:458-499`, `dialogs.ts`; REQ-000046-sJpO9KMY Requirement 3).
 * Changed from cttc's: no "Hosted on" (events always run on the Sump, D7);
 * the systems are the window's Sump's data stream, its containers (none
 * ticked: all, those it follows later too) and its host; the action's minutes
 * in one field; "Keep longer" in days (at most 30) instead of seconds.
 *
 * The Sump checks the event (Item 46): its reason is said as it gives it; a
 * stale edit reloads the event to edit again.
 */
import { useEffect, useState } from "react";
import { Button, Dialog } from "../components/index.js";
import type { SumpRequester } from "../shell/bridge.js";
import { listStreams, type Stream } from "../streams/api.js";
import {
  type Answer,
  type Condition,
  createEvent,
  type EventSpec,
  type SumpEvent,
  updateEvent,
} from "./api.js";

/** A condition row as typed: numbers kept as text until sent. */
interface Row {
  key: number;
  type: "metric" | "log";
  metric: "cpu" | "mem" | "net";
  op: string;
  threshold: string;
  pattern: string;
}

let rowKeys = 0;

/** cttc's new condition row: CPU % > 80. */
function newRow(): Row {
  return { key: ++rowKeys, type: "metric", metric: "cpu", op: ">", threshold: "80", pattern: "" };
}

/** A row from a stored condition. */
function rowOf(c: Condition): Row {
  return c.type === "metric"
    ? { ...newRow(), metric: c.metric, op: c.op, threshold: String(c.threshold) }
    : { ...newRow(), type: "log", pattern: c.pattern };
}

/** The rows as conditions, or why one is not right (cttc's checks, before the Sump's). */
export function conditionsOf(rows: readonly Row[]): Condition[] | string {
  if (rows.length === 0) return "add at least one condition";
  const out: Condition[] = [];
  for (const row of rows) {
    if (row.type === "metric") {
      const threshold = Number(row.threshold);
      if (row.threshold.trim() === "" || !Number.isFinite(threshold))
        return "threshold must be a valid number";
      out.push({ type: "metric", metric: row.metric, op: row.op, threshold });
    } else {
      try {
        new RegExp(row.pattern);
      } catch {
        return `invalid regex: ${row.pattern}`;
      }
      out.push({ type: "log", pattern: row.pattern });
    }
  }
  return out;
}

/** The dialog's props. */
export interface EventFormDialogProps {
  open: boolean;
  /** The event edited, or null to create one. */
  editing: SumpEvent | null;
  request: SumpRequester;
  /** The window's active data stream, picked first when creating. */
  activeStream: string | null;
  /** Said in the status bar. */
  say: (text: string) => void;
  /** Saved: the event as the Sump answers it. */
  onSaved: (event: SumpEvent) => void;
  /** A stale edit: reload this event to edit again. */
  onStale: (event: SumpEvent) => void;
  onClose: () => void;
}

/** The dialog. */
export function EventFormDialog(props: EventFormDialogProps) {
  const { open, editing, request, activeStream, say, onSaved, onStale, onClose } = props;
  const [streams, setStreams] = useState<Stream[]>([]);
  const [name, setName] = useState("");
  const [stream, setStream] = useState("");
  const [containers, setContainers] = useState<Set<string>>(new Set());
  const [host, setHost] = useState(false);
  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [match, setMatch] = useState<"any" | "all">("any");
  const [kind, setKind] = useState<"snapshot" | "recording">("snapshot");
  const [minutes, setMinutes] = useState("5");
  const [duration, setDuration] = useState("10");
  const [safe, setSafe] = useState(false);
  const [keepDays, setKeepDays] = useState("7");
  const [busy, setBusy] = useState(false);

  // cttc's resetEventForm, or the edited event's fields.
  useEffect(() => {
    if (!open) return;
    void listStreams(request).then((r) => r.ok && setStreams(r.value));
    const e = editing;
    setName(e?.name ?? "");
    setStream(e?.stream ?? activeStream ?? "");
    setContainers(new Set(e?.containers ?? []));
    setHost(e?.host ?? false);
    setRows(e ? e.conditions.map(rowOf) : [newRow()]);
    setMatch(e?.match ?? "any");
    const k = e?.action.kind === "recording" ? "recording" : "snapshot";
    setKind(k);
    setMinutes(k === "snapshot" && e ? String(e.action.minutes) : "5");
    setDuration(k === "recording" && e ? String(e.action.minutes) : "10");
    setSafe((e?.action.keep_days ?? 0) > 0);
    setKeepDays(e && e.action.keep_days > 0 ? String(e.action.keep_days) : "7");
  }, [open, editing, activeStream, request]);

  const followed = streams.find((s) => s.id === stream)?.followed?.containers ?? [];
  const setRow = (key: number, change: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...change } : r)));

  const save = async () => {
    const conditions = conditionsOf(rows);
    if (typeof conditions === "string") return say(conditions);
    if (!name.trim()) return say("give the event a name");
    if (!stream) return say("pick a data stream");
    const spec: EventSpec = {
      name: name.trim(),
      stream,
      containers: [...containers].filter((c) => followed.includes(c)),
      host,
      conditions,
      match,
      action: {
        kind,
        minutes: Number(kind === "snapshot" ? minutes : duration),
        keep_days: safe ? Number(keepDays) : 0,
      },
    };
    setBusy(true);
    let r: Answer<SumpEvent>;
    try {
      r = editing ? await updateEvent(request, editing, spec) : await createEvent(request, spec);
    } finally {
      setBusy(false);
    }
    if (r.ok) {
      say(`Event "${spec.name}" ${editing ? "updated" : "created"}`);
      onSaved(r.value);
      return onClose();
    }
    say(`could not ${editing ? "update" : "create"} event: ${r.message}`);
    if (r.stale && editing) onStale(editing);
  };

  return (
    <Dialog
      id="dlg-event-form"
      open={open}
      onClose={onClose}
      title={<span id="event-form-title">{editing ? "Edit Event" : "Create Event"}</span>}
    >
      <p className="dlg-intro muted">
        Watch CPU/MEM/NET thresholds or a log regex on chosen systems, and automatically take a
        snapshot or start a recording when the condition is met. Keeps watching until disabled or
        deleted (see Edit Events).
      </p>
      <label className="ctl block">
        Name{" "}
        <input
          id="event-name"
          type="text"
          placeholder="e.g. high CPU on api"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
        />
      </label>
      <div className="dlg-section-help muted">Systems monitored</div>
      <div id="event-systems">
        <label className="ctl block">
          Data stream{" "}
          <select
            id="event-stream"
            value={stream}
            onChange={(e) => setStream(e.currentTarget.value)}
          >
            {stream === "" ? <option value="">— pick a data stream —</option> : null}
            {streams.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        {followed.map((c) => (
          <label className="ctl block" key={c}>
            <input
              type="checkbox"
              data-event-system="1"
              value={c}
              checked={containers.has(c)}
              onChange={(e) => {
                const next = new Set(containers);
                if (e.currentTarget.checked) next.add(c);
                else next.delete(c);
                setContainers(next);
              }}
            />{" "}
            {c} (container)
          </label>
        ))}
        <label className="ctl block">
          <input
            type="checkbox"
            data-event-system="1"
            value="__host__"
            checked={host}
            onChange={(e) => setHost(e.currentTarget.checked)}
          />{" "}
          host (host)
        </label>
      </div>
      <div className="dlg-section-help muted">Conditions (one or more)</div>
      <div id="event-conditions">
        {rows.map((row) => (
          <div className="keys-box" data-condition-row="1" key={row.key}>
            <label className="ctl">
              Condition{" "}
              <select
                data-field="type"
                value={row.type}
                onChange={(e) =>
                  setRow(row.key, { type: e.currentTarget.value === "log" ? "log" : "metric" })
                }
              >
                <option value="metric">Metric threshold</option>
                <option value="log">Log regular expression</option>
              </select>
            </label>{" "}
            <span data-fields="metric" hidden={row.type !== "metric"}>
              <label className="ctl">
                Metric{" "}
                <select
                  data-field="metric"
                  value={row.metric}
                  onChange={(e) =>
                    setRow(row.key, { metric: e.currentTarget.value as Row["metric"] })
                  }
                >
                  <option value="cpu">CPU %</option>
                  <option value="mem">MEM %</option>
                  <option value="net">NET B/s</option>
                </select>
              </label>{" "}
              <label className="ctl">
                Op{" "}
                <select
                  data-field="op"
                  value={row.op}
                  onChange={(e) => setRow(row.key, { op: e.currentTarget.value })}
                >
                  <option value=">">&gt;</option>
                  <option value="<">&lt;</option>
                  <option value=">=">&gt;=</option>
                  <option value="<=">&lt;=</option>
                  <option value="=">=</option>
                </select>
              </label>{" "}
              <label className="ctl">
                Threshold{" "}
                <input
                  data-field="threshold"
                  type="number"
                  step="any"
                  value={row.threshold}
                  onChange={(e) => setRow(row.key, { threshold: e.currentTarget.value })}
                />
              </label>
            </span>{" "}
            <span data-fields="log" hidden={row.type !== "log"}>
              <label className="ctl block">
                Regex{" "}
                <input
                  data-field="pattern"
                  type="text"
                  placeholder="e.g. ERROR|FATAL"
                  value={row.pattern}
                  onChange={(e) => setRow(row.key, { pattern: e.currentTarget.value })}
                />
              </label>
            </span>{" "}
            <button
              type="button"
              data-remove-condition=""
              onClick={() => setRows((rs) => rs.filter((r) => r.key !== row.key))}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
      <div className="dlg-actions">
        <button
          type="button"
          id="event-add-condition"
          onClick={() => setRows((rs) => [...rs, newRow()])}
        >
          + Add condition
        </button>
      </div>
      <label className="ctl block" id="event-match-row" hidden={rows.length < 2}>
        Trigger when{" "}
        <select
          id="event-match"
          value={match}
          onChange={(e) => setMatch(e.currentTarget.value === "all" ? "all" : "any")}
        >
          <option value="any">any condition is met</option>
          <option value="all">all conditions are met</option>
        </select>
      </label>
      <label className="ctl block">
        Action{" "}
        <select
          id="event-action-kind"
          value={kind}
          onChange={(e) =>
            setKind(e.currentTarget.value === "recording" ? "recording" : "snapshot")
          }
        >
          <option value="snapshot">Take a snapshot</option>
          <option value="recording">Start a recording</option>
        </select>
      </label>
      <label className="ctl" id="event-action-minutes-row" hidden={kind !== "snapshot"}>
        Window (minutes){" "}
        <input
          id="event-action-minutes"
          type="number"
          min="1"
          step="1"
          value={minutes}
          onChange={(e) => setMinutes(e.currentTarget.value)}
        />
      </label>
      <label className="ctl" id="event-action-duration-row" hidden={kind !== "recording"}>
        Duration (minutes){" "}
        <input
          id="event-action-duration"
          type="number"
          min="1"
          step="1"
          value={duration}
          onChange={(e) => setDuration(e.currentTarget.value)}
        />
      </label>
      <label className="ctl block">
        <input
          id="event-safe"
          type="checkbox"
          checked={safe}
          onChange={(e) => setSafe(e.currentTarget.checked)}
        />{" "}
        Keep longer than the default retention window
      </label>
      <label className="ctl" id="event-max-keep-row" hidden={!safe}>
        Keep (days, at most 30){" "}
        <input
          id="event-keep-days"
          type="number"
          min="1"
          max="30"
          step="1"
          value={keepDays}
          onChange={(e) => setKeepDays(e.currentTarget.value)}
        />
      </label>
      <div className="dlg-actions">
        <Button id="dlg-event-form-cancel" onClick={onClose}>
          Cancel
        </Button>
        <Button id="dlg-event-create" kind="primary" disabled={busy} onClick={() => void save()}>
          {editing ? "Save changes" : "Create event"}
        </Button>
      </div>
    </Dialog>
  );
}
