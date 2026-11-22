/**
 * cttc's Opened Data dialog (`index.html:767-774`, `app.js`
 * `populateOpenedDataList` ~3260; REQ-000034-sJpO9KMY Requirement 3): one row
 * per file open in the window's analysis view, the active one marked; a click
 * (or Enter) on a row shows that file and closes the dialog; Remove closes
 * that file (the file on disk untouched) and the list stays.
 */
import { Button, Dialog } from "../components/index.js";
import type { OpenList } from "./bridge.js";

/** The dialog's props. */
export interface OpenedDataProps {
  open: boolean;
  list: OpenList;
  onSwitch: (path: string) => void;
  onRemove: (path: string) => void;
  onClose: () => void;
}

/** The dialog. */
export function OpenedData({ open, list, onSwitch, onRemove, onClose }: OpenedDataProps) {
  return (
    <Dialog
      id="dlg-opened-data"
      open={open}
      onClose={onClose}
      title="Opened Data"
      actions={
        <Button id="dlg-opened-data-cancel" title="Close without switching" onClick={onClose}>
          Cancel
        </Button>
      }
    >
      <p className="dlg-intro muted">Switch to one of the metric/recording files currently open.</p>
      <div
        id="opened-data-list"
        className="opened-data-list"
        role="listbox"
        aria-label="Open files"
      >
        {list.files.length === 0 ? (
          <div className="opened-data-empty">No files currently open</div>
        ) : (
          list.files.map((file) => {
            const active = file.path === list.active;
            return (
              <div
                key={file.path}
                className="opened-data-row"
                data-path={file.path}
                data-active={active ? "true" : undefined}
                role="option"
                aria-selected={active}
                tabIndex={0}
                title={file.path}
                onClick={() => onSwitch(file.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSwitch(file.path);
                  }
                }}
              >
                <span className="opened-data-row-name">{file.label}</span>
                <button
                  type="button"
                  className="opened-data-row-remove"
                  title="Remove from memory (the file itself is untouched)"
                  aria-label={`Remove ${file.label}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(file.path);
                  }}
                >
                  Remove
                </button>
              </div>
            );
          })
        )}
      </div>
    </Dialog>
  );
}
