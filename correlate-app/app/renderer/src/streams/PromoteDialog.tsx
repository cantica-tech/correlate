/**
 * Promote… (REQ-000052-sJpO9KMY Requirement 4, br-FED-000001 and
 * br-FED-000004-sJpO9KMY): pick a data stream over SSH; Promote has the
 * window's Sump provision a Sump of its own on that host, owned by you, which
 * collects the stream from then on. The Sump keeps answering the stream,
 * through the secondary; the secondary joins your Sumps when this app can
 * reach the host with its own key, and why not is said otherwise.
 */
import { useEffect, useState } from "react";
import { Button, Dialog } from "../components/index.js";
import type { PromoteResult, ShellBridge } from "../shell/bridge.js";
import { listStreams, type Stream } from "./api.js";

/** The dialog's props. */
export interface PromoteDialogProps {
  bridge: ShellBridge;
  open: boolean;
  onClose: () => void;
  /** Called after a promotion, for the pill to read the streams again. */
  onPromoted?: () => void;
}

/** What a promotion's answer says, for people. */
export function promoteText(result: PromoteResult): string {
  if (!result.ok) return result.message;
  const name = `${result.secondary.host} (secondary)`;
  return result.catalog.ok
    ? `Promoted: ${name} collects it now, and is in your Sumps as "${result.catalog.name}"`
    : `Promoted: ${name} collects it now; not added to your Sumps (${result.catalog.message})`;
}

/** The streams Promote offers: over SSH, not yet promoted. */
export function promotable(streams: Stream[]): Stream[] {
  return streams.filter((s) => s.kind === "ssh" && !s.secondary);
}

/** The Promote dialog. */
export function PromoteDialog({ bridge, open, onClose, onPromoted }: PromoteDialogProps) {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [chosen, setChosen] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStatus("");
    void (async () => {
      const r = await listStreams(bridge.sump.request);
      if (!r.ok) return setStatus(r.message);
      const offered = promotable(r.value);
      setStreams(offered);
      const active = (await bridge.stream?.active()) ?? null;
      setChosen(offered.find((s) => s.id === active)?.id ?? offered[0]?.id ?? "");
      if (offered.length === 0) setStatus("No data stream over SSH to promote");
    })();
  }, [open, bridge]);

  const promote = async () => {
    if (!chosen || !bridge.stream?.promote) return;
    const label = streams.find((s) => s.id === chosen)?.label ?? chosen;
    setBusy(true);
    setStatus(`Provisioning a Sump on ${label}'s host…`);
    const result = await bridge.stream.promote(chosen);
    setBusy(false);
    const text = promoteText(result);
    setStatus(text);
    void bridge.status.add(text);
    if (result.ok) {
      onPromoted?.();
      onClose();
    }
  };

  return (
    <Dialog
      id="dlg-promote"
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Promote to a Secondary Sump"
      actions={
        <>
          <Button id="dlg-promote-cancel" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            id="dlg-promote-ok"
            kind="primary"
            title="Provision a Sump on the stream's host that collects it from now on"
            disabled={busy || !chosen}
            onClick={() => void promote()}
          >
            Promote
          </Button>
        </>
      }
    >
      <p className="dlg-intro muted">
        A Sump of its own is installed on the stream's host, with this Sump's SSH access, and
        collects the stream there from now on, even while this Sump is down. You own it; this Sump
        keeps showing the stream, its history before now included.
      </p>
      <label className="ctl block">
        Data stream
        <select
          id="promote-stream"
          value={chosen}
          disabled={busy}
          onChange={(e) => setChosen(e.currentTarget.value)}
        >
          {streams.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </label>
      <div id="promote-status" className="muted">
        {status}
      </div>
    </Dialog>
  );
}
