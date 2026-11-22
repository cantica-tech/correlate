/**
 * cttc's side of the Opened Data dialog's parity check (REQ-000034-sJpO9KMY
 * Requirement 4): `#dlg-opened-data` (`index.html:767-774`, d8a444b) with
 * its rows as `populateOpenedDataList` builds them (`app.js` ~3260), for the
 * parity files, the active one marked; or empty.
 */
import { OPENED_FILES } from "./openedData.js";

const attr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** cttc's dialog; `empty`: no files open. */
export function cttcOpenedData(empty: boolean): string {
  const rows = empty
    ? '<div class="opened-data-empty">No files currently open</div>'
    : OPENED_FILES.files
        .map(
          (f) =>
            `<div class="opened-data-row" data-path="${attr(f.path)}" role="option"${f.path === OPENED_FILES.active ? ' data-active="true"' : ""}><span class="opened-data-row-name">${f.label}</span><button class="opened-data-row-remove" title="Remove from memory (the file itself is untouched)">Remove</button></div>`,
        )
        .join("");
  return `<dialog id="dlg-opened-data">
    <h2>Opened Data</h2>
    <p class="dlg-intro muted">Switch to one of the metric/recording files currently open.</p>
    <div id="opened-data-list" class="opened-data-list" role="listbox">${rows}</div>
    <div class="dlg-actions">
      <button id="dlg-opened-data-cancel" title="Close without switching">Cancel</button>
    </div>
  </dialog>`;
}
