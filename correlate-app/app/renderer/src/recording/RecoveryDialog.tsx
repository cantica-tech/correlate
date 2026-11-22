/**
 * cttc's "Recording interrupted" dialog (`index.html:800-810`,
 * `recoverInterruptedRecording` `app.js:3655`; REQ-000038-sJpO9KMY
 * Requirement 3): after a crash, Resume from the interruption point (the
 * default), Resume from now, or Decide later. When the recording's Sump has
 * left the catalog, both Resume buttons are disabled and say why.
 */
import { Button, Dialog } from "../components/index.js";

/** The dialog's props. */
export interface RecoveryDialogProps {
  open: boolean;
  /** The recording's Sump has left the catalog. */
  sumpGone: boolean;
  onInterruption: () => void;
  onNow: () => void;
  onLater: () => void;
}

/** Why Resume cannot be chosen when the Sump is gone. */
const GONE = "The recording's Sump is no longer known: Stop saves what was recorded";

/** The dialog. */
export function RecoveryDialog({
  open,
  sumpGone,
  onInterruption,
  onNow,
  onLater,
}: RecoveryDialogProps) {
  return (
    <Dialog
      id="dlg-recording-resume-choice"
      open={open}
      onClose={onLater}
      title="Recording interrupted"
      actions={
        <>
          <Button
            id="dlg-recording-resume-choice-later"
            title="Leave the recording paused for now — Resume/Stop remain available"
            onClick={onLater}
          >
            Decide later
          </Button>
          <Button
            id="dlg-recording-resume-choice-now"
            title={sumpGone ? GONE : "Start a fresh segment at the moment the app restarted"}
            disabled={sumpGone}
            onClick={onNow}
          >
            Resume from now
          </Button>
          <Button
            id="dlg-recording-resume-choice-interruption"
            kind="primary"
            title={
              sumpGone
                ? GONE
                : "Continue the interrupted segment, backfilling whatever survived on the Sump"
            }
            disabled={sumpGone}
            onClick={onInterruption}
          >
            Resume from the interruption point
          </Button>
        </>
      }
    >
      <p className="dlg-intro muted">
        A previous recording was interrupted before it could be paused or stopped. How would you
        like to resume it?
      </p>
      <p className="dlg-intro muted">
        <strong>Resume from the interruption point</strong> continues the same segment from when it
        was interrupted — whatever telemetry was actually captured in the meantime will be included
        once you next Pause or Stop; anything genuinely missing (never collected, or past the
        retention window) stays a real gap.
      </p>
      <p className="dlg-intro muted">
        <strong>Resume from now</strong> starts a fresh segment at the moment this app restarted,
        leaving the interruption itself as an honest, unhighlighted gap.
      </p>
    </Dialog>
  );
}
