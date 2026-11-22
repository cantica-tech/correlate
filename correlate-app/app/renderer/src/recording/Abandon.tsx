/**
 * Asking before abandoning a recording (br-REC-000001-sJpO9KMY, cttc's
 * `confirmAbandonRecordingIfAny` `app.js:3573`; REQ-000039-sJpO9KMY
 * Requirement 2): while the recording is not idle, every action that
 * changes, edits or removes the active Sump or the recording's data stream
 * asks first, in one dialog; Abandon recording discards it, then the action
 * goes on. The Shell provides the question; components ask it with
 * `useConfirmAbandon()`.
 */
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";
import { Button, Dialog } from "../components/index.js";
import type { RecordingState, ShellBridge } from "../shell/bridge.js";

/**
 * Ask before `action` ("Switching to Sump b", ...): true to go on (nothing
 * recording, or the user abandoned it), false to stop. `when` narrows it to
 * the recordings the action touches.
 */
export type ConfirmAbandon = (
  action: string,
  when?: (recording: RecordingState) => boolean,
) => Promise<boolean>;

/** Without a Shell (a component alone), nothing is asked. */
const AbandonContext = createContext<ConfirmAbandon>(async () => true);

/** The question, as the Shell provides it. */
export function useConfirmAbandon(): ConfirmAbandon {
  return useContext(AbandonContext);
}

/** The recording's state in words, as the dialog says it. */
export function recordingWords(status: RecordingState["status"]): string {
  if (status === "recording") return "in progress";
  if (status === "paused") return "paused";
  return "stopped but not saved";
}

/** Whether `action` must ask: a recording not idle, and touched (`when`). */
export function needsAsking(
  recording: RecordingState | null | undefined,
  when?: (recording: RecordingState) => boolean,
): recording is RecordingState {
  if (!recording || recording.status === "idle") return false;
  return when ? when(recording) : true;
}

/** The dialog's props. */
export interface AbandonDialogProps {
  /** The action and the recording's state, or null when closed. */
  asking: { action: string; status: RecordingState["status"] } | null;
  onCancel: () => void;
  onAbandon: () => void;
}

/** "Abandon the recording?": Cancel, or Abandon recording (danger). */
export function AbandonDialog({ asking, onCancel, onAbandon }: AbandonDialogProps) {
  return (
    <Dialog
      id="dlg-abandon-recording"
      open={asking !== null}
      onClose={onCancel}
      title="Abandon the recording?"
      actions={
        <>
          <Button id="dlg-abandon-recording-cancel" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            id="dlg-abandon-recording-confirm"
            kind="danger"
            title="Discard the recording, then go on"
            onClick={onAbandon}
          >
            Abandon recording
          </Button>
        </>
      }
    >
      <p className="dlg-intro">
        {asking
          ? `${asking.action} will abandon the recording ${recordingWords(asking.status)}: it has not been saved and will be discarded. Stop first to keep it.`
          : ""}
      </p>
    </Dialog>
  );
}

/** The Shell's side: the question for its components, and its dialog. */
export function AbandonProvider({
  bridge,
  children,
}: {
  bridge: Pick<ShellBridge, "recording">;
  children: ReactNode;
}) {
  const [asking, setAsking] = useState<AbandonDialogProps["asking"]>(null);
  const answer = useRef<((go: boolean) => void) | null>(null);

  const confirmAbandon = useCallback<ConfirmAbandon>(
    async (action, when) => {
      const recording = await bridge.recording?.get();
      if (!needsAsking(recording, when)) return true;
      answer.current?.(false);
      const go = await new Promise<boolean>((resolve) => {
        answer.current = resolve;
        setAsking({ action, status: recording.status });
      });
      if (go) await bridge.recording?.discard?.();
      return go;
    },
    [bridge],
  );

  const close = (go: boolean) => {
    setAsking(null);
    const resolve = answer.current;
    answer.current = null;
    resolve?.(go);
  };

  return (
    <AbandonContext.Provider value={confirmAbandon}>
      {children}
      <AbandonDialog asking={asking} onCancel={() => close(false)} onAbandon={() => close(true)} />
    </AbandonContext.Provider>
  );
}
