/**
 * The data-stream picker (REQ-000025-sJpO9KMY Requirement 4): cttc's Set
 * Sources dialog (`index.html:312-375`, `set-dialog.ts` at d8a444b), for
 * correlate-app's data streams. Pick a stream, or add one over SSH (the
 * Sump's public key shown, to add to the host's `authorized_keys`); Fetch
 * Sources lists what runs there; OK makes the Sump's followed set exactly
 * the checklist (br-STREAM-000002-sJpO9KMY), and the Sump collects it.
 */
import { useEffect, useState } from "react";
import { Button, Dialog, Switch } from "../components/index.js";
import { Icon } from "../icons/Icon.js";
import { useConfirmAbandon } from "../recording/Abandon.js";
import type { ShellBridge } from "../shell/bridge.js";
import {
  addStream,
  listStreams,
  type Stream,
  setFollowed,
  setPrivate,
  streamTargets,
  sumpPublicKey,
  type Targets,
} from "./api.js";
import { followedFrom, initialChecked, TargetList } from "./TargetList.js";

/** The choice that means "a new stream over SSH". */
export const NEW_STREAM = "";

/** The dialog's props. */
export interface StreamsDialogProps {
  bridge: ShellBridge;
  /** Open, as New Data Stream… (a new stream first) or Edit Data Streams…. */
  mode: "new" | "edit" | null;
  onClose: () => void;
}

/** The picker. */
export function StreamsDialog({ bridge, mode, onClose }: StreamsDialogProps) {
  const confirmAbandon = useConfirmAbandon();
  const request = bridge.sump.request;
  const [streams, setStreams] = useState<Stream[]>([]);
  const [chosen, setChosen] = useState(NEW_STREAM);
  const [target, setTarget] = useState("");
  const [port, setPort] = useState(22);
  const [publicKey, setPublicKey] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [sumpId, setSumpId] = useState<string | null>(null);
  /** A new stream's Private switch (br-STREAM-000009-sJpO9KMY): off, shared. */
  const [newPrivate, setNewPrivate] = useState(false);

  const fetchTargets = async (id: string) => {
    setBusy(true);
    setError("");
    setStatus("Listing what runs there…");
    const r = await streamTargets(request, id);
    setBusy(false);
    if (!r.ok) {
      setStatus("");
      setTargets(null);
      return setError(r.message);
    }
    setTargets(r.value);
    setChecked(initialChecked(r.value));
    const n = r.value.containers.length + (r.value.services?.length ?? 0);
    setStatus(`${n} running`);
  };

  // On opening: the streams and the Sump's key; Edit lists the first stream.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once per opening.
  useEffect(() => {
    // Cleared on closing too, so a reopened dialog never shows the last one's list.
    setTargets(null);
    setStatus("");
    setError("");
    setNewPrivate(false);
    if (!mode) return;
    void (async () => {
      const [list, key] = await Promise.all([listStreams(request), sumpPublicKey(request)]);
      if (!list.ok) return setError(list.message);
      setStreams(list.value);
      if (key.ok) setPublicKey(key.value);
      // Edit opens on the stream last submitted on this Sump (REQ-000026-sJpO9KMY).
      const sump = (await bridge.sump.active?.())?.id;
      setSumpId(sump ?? null);
      const last = sump ? await bridge.picker?.lastStream(sump) : null;
      const first =
        mode !== "edit"
          ? NEW_STREAM
          : (list.value.find((s) => s.id === last)?.id ?? list.value[0]?.id ?? NEW_STREAM);
      setChosen(first);
      if (first !== NEW_STREAM) await fetchTargets(first);
    })();
  }, [mode]);

  const fetchSources = async () => {
    if (chosen !== NEW_STREAM) return fetchTargets(chosen);
    setBusy(true);
    setError("");
    setStatus(`Reaching Docker on ${target} over SSH…`);
    const added = await addStream(request, target.trim(), port, newPrivate);
    setBusy(false);
    if (!added.ok) {
      setStatus("");
      return setError(added.message);
    }
    const list = await listStreams(request);
    if (list.ok) setStreams(list.value);
    setChosen(added.value.id);
    await fetchTargets(added.value.id);
  };

  const submit = async () => {
    if (!targets || chosen === NEW_STREAM) return;
    // Editing the recording's stream, or switching to another, abandons it
    // (REQ-000039-sJpO9KMY).
    const current = (await bridge.stream?.active()) ?? null;
    const label = streams.find((s) => s.id === chosen)?.label ?? chosen;
    const go = await confirmAbandon(
      chosen === current ? `Editing data stream ${label}` : `Switching to data stream ${label}`,
      (recording) =>
        recording.target?.stream === chosen || (current !== null && chosen !== current),
    );
    if (!go) return;
    setBusy(true);
    const wanted = followedFrom(targets, checked);
    const r = await setFollowed(request, chosen, wanted);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    if (sumpId) void bridge.picker?.setLastStream({ sump: sumpId, stream: chosen });
    // The picker's stream becomes this window's active one (REQ-000027-sJpO9KMY).
    await bridge.stream?.setActive(chosen, true);
    const n = r.value.containers.length + r.value.services.length;
    void bridge.status.add(`Following ${n} on ${label}`);
    onClose();
  };

  const isNew = chosen === NEW_STREAM;
  const current = streams.find((s) => s.id === chosen);
  /** Make the chosen stream private or shared; a refusal is said in the Sump's words. */
  const changePrivate = async (stream: Stream, isPrivate: boolean) => {
    setError("");
    const r = await setPrivate(request, stream.id, isPrivate);
    if (!r.ok) return setError(r.message);
    setStreams((list) =>
      list.map((s) => (s.id === stream.id ? { ...s, private: r.value.private } : s)),
    );
  };
  // Drawn only when the Sump tells who added its streams (br-STREAM-000009):
  // a concept new to correlate-app, not in cttc's #dlg-set.
  const privacy =
    isNew && streams.some((s) => s.private !== undefined) ? (
      <Switch id="stream-private" checked={newPrivate} onChange={setNewPrivate}>
        Private: only you and the Sump's owner see it
      </Switch>
    ) : !isNew && current?.private !== undefined ? (
      <div className="ctl stream-owner-row">
        <Switch
          id="stream-private"
          checked={current.private}
          disabled={busy || current.may_change === false}
          title={
            current.may_change === false
              ? "Only who added it, or the Sump's owner, can change this"
              : undefined
          }
          onChange={(on) => void changePrivate(current, on)}
        >
          Private: only who added it and the Sump's owner see it
        </Switch>
        {current.created_by ? (
          <span id="stream-added-by" className="muted">
            Added by {current.created_by}
          </span>
        ) : null}
      </div>
    ) : null;
  return (
    <Dialog
      id="dlg-set"
      open={mode !== null}
      onClose={onClose}
      title={mode === "new" ? "New Data Stream" : "Edit Data Streams"}
      actions={
        <>
          <Button id="dlg-cancel" title="Close without changing what is followed" onClick={onClose}>
            Cancel
          </Button>
          <Button
            id="dlg-ok"
            kind="primary"
            title="Follow exactly the ticked containers and services"
            disabled={busy || !targets || isNew}
            onClick={() => void submit()}
          >
            Follow Selected
          </Button>
        </>
      }
    >
      <fieldset className="dlg-section" id="set-source-box">
        <legend>
          <Icon name="set-source" svgClassName="legend-icon" />
          Set source
        </legend>
        <label className="ctl block">
          Data stream
          <select
            id="stream-select"
            value={chosen}
            onChange={(e) => {
              setChosen(e.currentTarget.value);
              setTargets(null);
              setStatus("");
              setError("");
            }}
          >
            {streams.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
            <option value={NEW_STREAM}>New, over SSH…</option>
          </select>
        </label>
        {privacy}
        {isNew ? (
          <>
            <label className="ctl block">
              SSH target
              <input
                id="stream-target"
                type="text"
                placeholder="user@host"
                value={target}
                onChange={(e) => setTarget(e.currentTarget.value)}
              />
            </label>
            <label className="ctl block">
              SSH port
              <input
                id="stream-port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(e) => setPort(Number(e.currentTarget.value))}
              />
            </label>
            <label className="ctl block ssh-key-row">
              The Sump's key
              <span className="ctl">
                <input id="sump-public-key" type="text" readOnly value={publicKey} />
                <Button onClick={() => void navigator.clipboard?.writeText(publicKey)}>Copy</Button>
              </span>
              <span className="tdoc ssh-key-hint">
                (add this line to the host's ~/.ssh/authorized_keys; the Sump's private key never
                leaves it)
              </span>
            </label>
          </>
        ) : null}
        <div className="ctl fetch-row">
          <Button
            id="btn-ps-refresh"
            kind="fetch"
            title="Lists the containers and services running there now"
            disabled={busy || (isNew && !target.includes("@"))}
            onClick={() => void fetchSources()}
          >
            Fetch Sources
          </Button>
        </div>
        <div id="docker-status" className="muted">
          {status}
        </div>
        <div id="docker-error" className="error">
          {error}
        </div>
      </fieldset>
      <p className="dlg-intro muted">
        Logs and CPU/MEM/NET telemetry are collected for what you tick, by the Sump, even while this
        app is closed.
      </p>
      <fieldset className="dlg-section">
        <legend>
          <Icon name="history" svgClassName="legend-icon" />
          Logs
        </legend>
        <p className="dlg-section-help muted">
          Followed per container — tick the ones you want; what you untick stops.
        </p>
        {targets ? <TargetList targets={targets} checked={checked} onChange={setChecked} /> : null}
      </fieldset>
    </Dialog>
  );
}
