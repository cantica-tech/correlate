/**
 * cttc's Docker host pill, for the window's active data stream
 * (REQ-000027-sJpO9KMY Requirement 4): `#docker-host-status` beside the
 * Sump's pill, `up` while the stream collects, `down` when paused, `checking`
 * otherwise; a click opens its switcher (every stream, the active one
 * marked), a right-click its menu. The active stream is the main process's
 * (`stream.active`), healed here when it has none or its stream is gone.
 */
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { ContextMenu, type MenuEntry } from "../components/index.js";
import { Icon } from "../icons/Icon.js";
import type { ShellBridge } from "../shell/bridge.js";
import { healActive, streamPillState, streamRows, streamWhere } from "./active.js";
import { listStreams, type Stream } from "./api.js";

/** How often the pill reads the streams: as the Sump's pill is probed, 5 s. */
export const STREAMS_EVERY_MS = 5_000;

type Open =
  | { kind: "none" }
  | { kind: "switcher" }
  | { kind: "menu"; x: number; y: number }
  | { kind: "status" };

/** The pill's props. */
export interface StreamPillProps {
  bridge: ShellBridge;
  /** Runs a sidebar action (new-data-stream, edit-data-streams, ...). */
  onAction: (name: string) => void;
  /** Changes when the streams changed elsewhere (picker, Close, Remove). */
  version?: number;
}

/** The data-stream pill. */
export function StreamPill({ bridge, onAction, version = 0 }: StreamPillProps) {
  const [streams, setStreams] = useState<Stream[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>({ kind: "none" });
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    const list = await listStreams(bridge.sump.request);
    if (!list.ok) return;
    setStreams(list.value);
    const current = (await bridge.stream?.active()) ?? null;
    const sump = (await bridge.sump.active?.())?.id;
    const last = sump ? ((await bridge.picker?.lastStream(sump)) ?? null) : null;
    const healed = healActive(current, list.value, last);
    if (healed && healed !== current) await bridge.stream?.setActive(healed);
    setActive(healed);
  }, [bridge]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` asks for a refresh.
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), STREAMS_EVERY_MS);
    return () => clearInterval(timer);
  }, [refresh, version]);

  useEffect(() => {
    if (open.kind === "none" || open.kind === "menu") return;
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen({ kind: "none" });
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

  const stream = streams.find((s) => s.id === active);
  const state = streamPillState(stream);
  const label = stream
    ? `Data stream ${stream.label}: ${state === "up" ? "collecting" : state === "down" ? "paused" : "nothing followed"}`
    : "No data stream";
  const menu: MenuEntry[] = [
    { label: "New Data Stream…", icon: "connect", onSelect: () => onAction("new-data-stream") },
    {
      label: "Edit Data Streams…",
      icon: "set-source",
      onSelect: () => onAction("edit-data-streams"),
    },
    {
      label: "Close Data Streams",
      icon: "disconnect",
      onSelect: () => onAction("close-data-streams"),
    },
    {
      label: "Remove Data Stream…",
      icon: "remove",
      onSelect: () => onAction("remove-data-stream"),
    },
    "separator",
    {
      label: "Current Status",
      icon: "current-status",
      onSelect: () => setOpen({ kind: "status" }),
    },
  ];

  return (
    <div
      id="docker-host-status"
      className={open.kind === "switcher" ? "server-status open" : "server-status"}
      data-state={state}
      ref={ref}
    >
      <button
        id="docker-host-status-btn"
        type="button"
        className="server-status-btn"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open.kind === "switcher"}
        onClick={() => setOpen(open.kind === "switcher" ? { kind: "none" } : { kind: "switcher" })}
        onContextMenu={(e: ReactMouseEvent) => {
          e.preventDefault();
          setOpen({ kind: "menu", x: e.clientX, y: e.clientY });
        }}
      >
        <span className="server-status-dot" />
        <Icon name="data-stream" svgClassName="server-status-icon" />
      </button>
      {open.kind === "switcher" ? (
        <div
          id="docker-host-dropdown"
          className="gateway-dropdown"
          role="menu"
          aria-label="Switch data stream"
        >
          {streams.length === 0 ? (
            <div className="gateway-empty">No data streams yet — New Data Stream… adds one.</div>
          ) : (
            streams.flatMap((s, i) => [
              i > 0 ? <div className="gateway-item-sep" key={`sep-${s.id}`} /> : null,
              <button
                type="button"
                role="menuitem"
                className="gateway-item"
                key={s.id}
                data-active={String(s.id === active)}
                data-reachable={String(!s.paused)}
                aria-current={s.id === active ? "true" : undefined}
                onClick={
                  s.id === active
                    ? undefined
                    : () => {
                        setOpen({ kind: "none" });
                        void bridge.stream?.setActive(s.id).then(() => setActive(s.id));
                      }
                }
              >
                <span className="gateway-item-label">{s.label}</span>
                <span className="gateway-item-loc">{streamWhere(s)}</span>
              </button>,
            ])
          )}
        </div>
      ) : null}
      {open.kind === "status" && stream ? (
        <div id="docker-host-info-popup" className="connection-info-popup" role="tooltip">
          {streamRows(stream).map(([name, value]) => (
            <div className="cip-row" key={name}>
              <span className="cip-label">{name}</span>
              <span className="cip-val">{value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {open.kind === "menu" ? (
        <ContextMenu
          x={open.x}
          y={open.y}
          label="Data stream"
          entries={menu}
          onClose={() => setOpen((o) => (o.kind === "menu" ? { kind: "none" } : o))}
        />
      ) : null}
    </div>
  );
}
