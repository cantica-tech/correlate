/**
 * cttc's Edit Events dialog (`#dlg-event-list`, `index.html:503-510`,
 * `renderEventRow` in `dialogs.ts`; REQ-000046-sJpO9KMY Requirements 3-4):
 * the user's events on the window's Sump, one row each (`name -- conditions
 * -> action -- status`), with Update, Disable/Enable, Reset (when triggered)
 * and Erase; under each, its artifacts and their state. Download… is offered
 * only for a complete artifact and saves it into the project; a failed one
 * says why; Keep… keeps one longer (cttc bug 26).
 */
import { useCallback, useEffect, useState } from "react";
import { Button, Dialog } from "../components/index.js";
import { clock } from "../logs/api.js";
import type { SumpRequester } from "../shell/bridge.js";
import {
  type Artifact,
  actionText,
  conditionsText,
  deleteEvent,
  keepArtifact,
  listArtifacts,
  listEvents,
  resetEvent,
  type SumpEvent,
  updateEvent,
} from "./api.js";

/** The dialog's props. */
export interface EventListDialogProps {
  open: boolean;
  request: SumpRequester;
  /** Changes when a firing arrives or an event is saved: the list is read again. */
  version: number;
  say: (text: string) => void;
  /** Update…: open the form on this event. */
  onEdit: (event: SumpEvent) => void;
  /** Download… a complete artifact: saved and added to the project. */
  onDownload: (event: SumpEvent, artifact: Artifact) => void;
  onClose: () => void;
}

/** An artifact's line: `snapshot · complete · 12:00:30.000 · 1.2 MB`. */
export function artifactText(a: Artifact): string {
  const size = a.size === null ? "" : ` · ${(a.size / 1e6).toFixed(1)} MB`;
  const kept = a.safe ? " · kept" : "";
  const why = a.status === "failed" && a.reason ? ` (${a.reason})` : "";
  return `${a.kind} · ${a.status}${why} · ${clock(a.created_at)}${size}${kept}`;
}

/** The dialog. */
export function EventListDialog(props: EventListDialogProps) {
  const { open, request, version, say, onEdit, onDownload, onClose } = props;
  const [events, setEvents] = useState<SumpEvent[] | null>(null);
  const [artifacts, setArtifacts] = useState<Record<string, Artifact[]>>({});

  const refresh = useCallback(async () => {
    const r = await listEvents(request);
    if (!r.ok) {
      say(`could not list events: ${r.message}`);
      return setEvents([]);
    }
    setEvents(r.value);
    const pairs = await Promise.all(
      r.value.map(async (e) => {
        const a = await listArtifacts(request, e);
        return [e.id, a.ok ? a.value : []] as const;
      }),
    );
    setArtifacts(Object.fromEntries(pairs));
  }, [request, say]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a refresh.
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh, version]);

  /** Run a change and read the list again; a refusal said. */
  const act = async (done: Promise<{ ok: boolean; message?: string }>) => {
    const r = await done;
    if (!r.ok) say(r.message ?? "refused");
    await refresh();
  };

  return (
    <Dialog id="dlg-event-list" open={open} onClose={onClose} title="Edit Events">
      <p className="dlg-intro muted">
        This Sump's events -- update, disable/enable, or erase; download what they captured.
      </p>
      <div id="events-list">
        {events !== null && events.length === 0 ? "No events yet." : null}
        {events?.map((ev) => (
          <div key={ev.id}>
            <div className="ctl block">
              {`${ev.name} -- ${conditionsText(ev)} -> ${actionText(ev.action)} -- ${ev.enabled ? ev.status : "disabled"}${
                ev.status === "triggered" && ev.trigger_detail ? ` (${ev.trigger_detail})` : ""
              } `}
              <button type="button" onClick={() => onEdit(ev)}>
                Update
              </button>
              <button
                type="button"
                onClick={() => void act(updateEvent(request, ev, { enabled: !ev.enabled }))}
              >
                {ev.enabled ? "Disable" : "Enable"}
              </button>
              {ev.status === "triggered" ? (
                <button type="button" onClick={() => void act(resetEvent(request, ev))}>
                  Reset
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  void act(deleteEvent(request, ev)).then(() => say(`Event "${ev.name}" erased`));
                }}
              >
                Erase
              </button>
            </div>
            {(artifacts[ev.id] ?? []).map((a) => (
              <div className="ctl block event-artifact" key={a.id}>
                {`  ${artifactText(a)} `}
                <button
                  type="button"
                  disabled={a.status !== "complete"}
                  title={
                    a.status === "complete"
                      ? "Save it into the project"
                      : a.status === "pending"
                        ? "Still being made on the Sump"
                        : `It failed: ${a.reason ?? "unknown"}`
                  }
                  onClick={() => onDownload(ev, a)}
                >
                  Download…
                </button>
                <button
                  type="button"
                  title="Keep it 30 days on the Sump"
                  onClick={() => void act(keepArtifact(request, a, 30))}
                >
                  Keep…
                </button>
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="dlg-actions">
        <Button id="dlg-event-list-close" onClick={onClose}>
          Close
        </Button>
      </div>
    </Dialog>
  );
}
