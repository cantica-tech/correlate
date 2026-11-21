/**
 * cttc's status bar (REQ-000022-sJpO9KMY Requirements 2 to 4), in cttc's
 * markup (`index.html:268-306`) so cttc's rules in `statusbar.css` style it:
 * the newest message (cleared after 5 s), the Sump pill with its switcher,
 * right-click menu and Current Status, and History. Everything it shows
 * comes from the main process: the lifecycle (br-SUMP-000011-sJpO9KMY) and
 * the one feed of notifications.
 */
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button, ContextMenu, Dialog, type MenuEntry } from "../components/index.js";
import { Icon } from "../icons/Icon.js";
import type { ListedSump, Notice, ShellBridge, StateRecord } from "../shell/bridge.js";
import { NOT_YET } from "../shell/sections.js";
import { PILL_WORDS, pillState, statusRows, whereIs } from "./pill.js";

/** How long a message stays in the bar: cttc's default (5 s). */
export const MESSAGE_MS = 5_000;

/** A notice's time, as cttc's History shows it. */
const timeOf = (notice: Notice) => new Date(notice.at).toLocaleTimeString();

/** What is open: at most one thing at a time, as in cttc. */
type Open =
  | { kind: "none" }
  | { kind: "switcher"; sumps: ListedSump[] | null }
  | { kind: "menu"; x: number; y: number }
  | { kind: "status"; sump: ListedSump | null }
  | { kind: "history" };

/** The bar's props. */
export interface StatusBarProps {
  bridge: ShellBridge;
  /** Tells the shell this window's Sump changed. */
  onSwitched?: (id: string) => void;
}

/** The status bar. */
export function StatusBar({ bridge, onSwitched }: StatusBarProps) {
  const [visible, setVisible] = useState(true);
  const [history, setHistory] = useState<Notice[]>([]);
  const [message, setMessage] = useState("");
  const [active, setActive] = useState<{ id: string; name: string } | null>(null);
  const [states, setStates] = useState<ReadonlyMap<string, StateRecord>>(new Map());
  const [open, setOpen] = useState<Open>({ kind: "none" });
  const [confirm, setConfirm] = useState<{ sump: ListedSump; message: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pill = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const show = useCallback((text: string) => {
    setMessage(text);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(""), MESSAGE_MS);
  }, []);

  const refreshActive = useCallback(async () => {
    const a = await bridge.sump.active();
    setActive(a ? { id: a.id, name: a.name } : null);
  }, [bridge]);

  useEffect(() => {
    void bridge.status.visible().then(setVisible);
    void bridge.status.history().then(setHistory);
    void refreshActive();
    void bridge.sump.states().then((all) => setStates(new Map(all.map((r) => [r.id, r]))));
    const stops = [
      bridge.status.onVisibility(setVisible),
      bridge.status.onNotice((event) => {
        if (event.type === "cleared") return setHistory([]);
        setHistory((h) => [...h, event.entry].slice(-500));
        show(event.entry.text);
      }),
      bridge.sump.onState((record) => setStates((m) => new Map(m).set(record.id, record))),
    ];
    return () => {
      for (const stop of stops) stop();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bridge, refreshActive, show]);

  // Escape, or a click outside what is open, closes it (the menu closes itself).
  useEffect(() => {
    if (open.kind === "none" || open.kind === "menu") return;
    const inside = open.kind === "history" ? historyRef : pill;
    const outside = (e: MouseEvent) => {
      if (!inside.current?.contains(e.target as Node)) setOpen({ kind: "none" });
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen({ kind: "none" });
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open.kind]);

  const switchTo = async (sump: ListedSump, confirmed = false) => {
    setOpen({ kind: "none" });
    const result = await bridge.sump.switchTo({ id: sump.id, confirmed });
    if (result.ok) {
      await refreshActive();
      onSwitched?.(sump.id);
      void bridge.status.add(`Switched to Sump ${sump.name}`);
    } else if (result.step === "confirm") {
      setConfirm({ sump, message: result.message });
    } else {
      void bridge.status.add(
        `Switch to Sump ${sump.name} refused: ${result.message}`.slice(0, 500),
      );
    }
  };

  const openSwitcher = async () => {
    if (open.kind === "switcher") return setOpen({ kind: "none" });
    setOpen({ kind: "switcher", sumps: null });
    const sumps = await bridge.sump.list();
    setOpen((o) => (o.kind === "switcher" ? { kind: "switcher", sumps } : o));
  };

  const openMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    setOpen({ kind: "menu", x: event.clientX, y: event.clientY });
  };

  const showStatus = async () => {
    setOpen({ kind: "status", sump: null });
    const sumps = await bridge.sump.list();
    const sump = sumps.find((s) => s.current) ?? null;
    setOpen((o) => (o.kind === "status" ? { kind: "status", sump } : o));
  };

  const state = pillState(active?.id, states);
  const label = active
    ? `Sump ${active.name}: ${PILL_WORDS[state]}`
    : `No Sump: ${PILL_WORDS[state]}`;
  const notYet = (title: string) => `${title} (${NOT_YET})`;
  const never = () => {};
  const menu: MenuEntry[] = [
    {
      label: "New Sump…",
      icon: "new",
      disabled: true,
      title: notYet("Provision a Sump"),
      onSelect: never,
    },
    {
      label: "Edit Sump…",
      icon: "edit",
      disabled: true,
      title: notYet("Rename a Sump or replace its key"),
      onSelect: never,
    },
    {
      label: "Uninstall Sump…",
      icon: "remove",
      disabled: true,
      title: notYet("Remove a Sump"),
      onSelect: never,
    },
    "separator",
    { label: "Current Status", icon: "current-status", onSelect: () => void showStatus() },
  ];

  return (
    <div id="app-status-bar" className="app-status-bar" hidden={!visible}>
      <span id="app-status-bar-text">{message}</span>
      <span className="status-bar-divider" />
      <div
        id="server-status"
        className={open.kind === "switcher" ? "server-status open" : "server-status"}
        data-state={state}
        ref={pill}
      >
        <button
          id="server-status-btn"
          type="button"
          className="server-status-btn"
          aria-label={label}
          title={label}
          aria-haspopup="menu"
          aria-expanded={open.kind === "switcher"}
          onClick={() => void openSwitcher()}
          onContextMenu={openMenu}
        >
          <span className="server-status-dot" />
          <Icon name="sump" svgClassName="server-status-icon" />
        </button>
        {open.kind === "switcher" ? (
          <div
            id="gateway-dropdown"
            className="gateway-dropdown"
            role="menu"
            aria-label="Switch Sump"
          >
            {open.sumps === null ? null : open.sumps.length === 0 ? (
              <div className="gateway-empty">No Sumps yet — New Sump… adds one.</div>
            ) : (
              open.sumps.flatMap((sump, i) => [
                i > 0 ? <div className="gateway-item-sep" key={`sep-${sump.id}`} /> : null,
                <button
                  type="button"
                  role="menuitem"
                  className="gateway-item"
                  key={sump.id}
                  data-active={String(sump.current)}
                  data-reachable={String(sump.state === "active")}
                  aria-current={sump.current ? "true" : undefined}
                  onClick={sump.current ? undefined : () => void switchTo(sump)}
                >
                  <span className="gateway-item-label">{sump.name}</span>
                  <span className="gateway-item-loc">{whereIs(sump)}</span>
                </button>,
              ])
            )}
          </div>
        ) : null}
        {open.kind === "status" && open.sump ? (
          <div id="connection-info-popup" className="connection-info-popup" role="tooltip">
            {statusRows(open.sump).map((row, i) =>
              row === null ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity but their place.
                <div className="cip-sep" key={`sep-${i}`} />
              ) : (
                <div className="cip-row" key={row[0]}>
                  <span className="cip-label">{row[0]}</span>
                  <span className="cip-val">{row[1]}</span>
                </div>
              ),
            )}
          </div>
        ) : null}
      </div>
      <span className="status-bar-divider status-bar-divider-double" />
      <div ref={historyRef} style={{ display: "contents" }}>
        <button
          type="button"
          id="status-bar-history-btn"
          className="status-bar-history-btn"
          title="History"
          aria-expanded={open.kind === "history"}
          onClick={() => setOpen(open.kind === "history" ? { kind: "none" } : { kind: "history" })}
        >
          <Icon name="history" />
          History
        </button>
        {open.kind === "history" ? (
          <div id="status-bar-history-popup" className="status-bar-history-popup">
            <div className="status-bar-history-head">
              <span>History</span>
              <button
                type="button"
                id="status-bar-history-clear"
                className="linklike"
                onClick={() => void bridge.status.clear()}
              >
                Clear
              </button>
            </div>
            <div id="status-bar-history-list" className="activity-log status-bar-history-list">
              {history.length === 0 ? (
                <div className="status-bar-history-empty">Nothing yet.</div>
              ) : (
                [...history].reverse().map((notice, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: two notices may share their time and text.
                  <div className="status-bar-history-row" key={`${notice.at}-${i}`}>
                    <span className="sbh-ts">{timeOf(notice)}</span>
                    <span>{notice.text}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>
      {open.kind === "menu" ? (
        <ContextMenu
          x={open.x}
          y={open.y}
          label="Sump"
          entries={menu}
          onClose={() => setOpen((o) => (o.kind === "menu" ? { kind: "none" } : o))}
        />
      ) : null}
      <Dialog
        id="dlg-switch-confirm"
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Switch Sump?"
        actions={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              kind="danger"
              onClick={() => {
                const sump = confirm?.sump;
                setConfirm(null);
                if (sump) void switchTo(sump, true);
              }}
            >
              Switch
            </Button>
          </>
        }
      >
        <p className="dlg-intro">
          {confirm ? `Switching to Sump ${confirm.sump.name}: ${confirm.message}` : ""}
        </p>
      </Dialog>
    </div>
  );
}
