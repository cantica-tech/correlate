/**
 * cttc's modal (REQ-000020-sJpO9KMY Requirement 1): a native `<dialog>`,
 * opened with `showModal()` so the page behind it is inert and focus stays
 * inside. Escape closes it, as the browser does and as in cttc, and the
 * owner is told; a click on the backdrop does nothing, as in cttc.
 */
import { type ReactNode, useEffect, useRef } from "react";

/** The dialog's props. */
export interface DialogProps {
  /** Shown as a modal while true. */
  open: boolean;
  /** Called when the dialog closes on its own (Escape). */
  onClose: () => void;
  /** Its title, in an `<h2>`, which also names the dialog. */
  title: ReactNode;
  /** Buttons, right-aligned in `.dlg-actions` below the body. */
  actions?: ReactNode;
  /** An `id` for the element, as cttc's `#dlg-…`. */
  id?: string;
  className?: string;
  children?: ReactNode;
}

let counter = 0;

/** A modal dialog with a title, a body and its buttons. */
export function Dialog({ open, onClose, title, actions, id, className, children }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useRef(`dlg-title-${++counter}`).current;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const closed = () => onCloseRef.current();
    dialog.addEventListener("close", closed);
    return () => dialog.removeEventListener("close", closed);
  }, []);

  return (
    <dialog ref={ref} id={id} className={className} aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      {children}
      {actions ? <div className="dlg-actions">{actions}</div> : null}
    </dialog>
  );
}
