/**
 * One log panel (REQ-000029-sJpO9KMY Requirement 2, br-LOGV-000001-sJpO9KMY),
 * in cttc's markup (`Panel`, `app.js:2360-2700`): the head (menu, name, row
 * count), the search bar, and `.panel-body` of 22 px `.log-row`s, only those
 * in view drawn (`logWindow`), their 200-row pages fetched on demand
 * (`PageCache`). Rows within the highlight window of the cursor are marked as
 * cttc's runs (`hl`, `hl-top`, `hl-bottom`); the cursor is set by Item 31.
 */
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, type MenuEntry } from "../components/index.js";
import type { Viewport } from "../correlate/atoms.js";
import { visibleRange } from "../correlate/logWindow.js";
import { isHighlighted } from "../correlate/timeMapping.js";
import { Icon } from "../icons/Icon.js";
import type { SumpRequester } from "../shell/bridge.js";
import { clock, findRow, levelOf, type Order, pageFetcher } from "./api.js";
import { PageCache } from "./pages.js";

/** A row's height: cttc's `ROWH`. */
export const ROW_HEIGHT = 22;

/** A panel's props. */
export interface LogPanelProps {
  request: SumpRequester;
  /** The Sump's source: `stream/container`. */
  source: string;
  /** The container's name, the panel's title. */
  name: string;
  /** The charts' time range; a new one reads the rows again. */
  view: Viewport;
  order: Order;
  onOrder: (order: Order) => void;
  /** The cursor's time, or null (Item 31 sets it). */
  cursorT?: number | null;
  /** How far from the cursor a row is highlighted, in ms. */
  windowMs?: number;
  /** Export .log: the main process asks for the file first. */
  onExport: () => void;
  /** cttc's ✕: hide the container, as its legend entry does. */
  onHide?: () => void;
}

/** A log panel. */
export function LogPanel({
  request,
  source,
  name,
  view,
  order,
  onOrder,
  cursorT = null,
  windowMs = 500,
  onExport,
  onHide,
}: LogPanelProps) {
  const [, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [matchIndex, setMatchIndex] = useState<number | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const cache = useMemo(
    () =>
      new PageCache(async () => ({ rows: [], total: 0 }), {
        onChange: () => setTick((t) => t + 1),
      }),
    [],
  );
  useEffect(() => () => cache.dispose(), [cache]);

  // Another source or order: everything again, from the top.
  const shown = useRef({ source: "", order: "" });
  useEffect(() => {
    const fetch = pageFetcher(request, source, view, order);
    if (shown.current.source !== source || shown.current.order !== order) {
      shown.current = { source, order };
      cache.clear(fetch);
      setMatchIndex(null);
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
      setScrollTop(0);
    } else {
      cache.reset(fetch);
    }
    setTick((t) => t + 1);
  }, [cache, request, source, order, view]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    setHeight(el.clientHeight);
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Before the first page comes, page 0 is wanted so the total is known.
  const total = cache.total ?? 0;
  const { i0, i1 } =
    cache.total === null
      ? { i0: 0, i1: 0 }
      : visibleRange(scrollTop, height || ROW_HEIGHT * 10, ROW_HEIGHT, total);
  useEffect(() => {
    cache.want(i0, Math.max(i0, i1));
  });

  const needle = query.toLowerCase();
  const rows = [];
  let previousHl = false;
  for (let i = i0; i <= i1 && cache.total !== null; i++) {
    const row = cache.row(i);
    if (!row) {
      previousHl = false;
      continue;
    }
    const ts = Date.parse(row.ts);
    const hl = isHighlighted(ts, cursorT, windowMs);
    const next = hl && i < i1 ? cache.row(i + 1) : undefined;
    const nextHl = next ? isHighlighted(Date.parse(next.ts), cursorT, windowMs) : false;
    const level = levelOf(row.text);
    const classes = [
      "log-row",
      hl ? "hl" : "",
      hl && !previousHl ? "hl-top" : "",
      hl && !nextHl ? "hl-bottom" : "",
      i === matchIndex ? "cursor-row" : "",
      level ? `lvl-${level}` : "",
      needle && row.text.toLowerCase().includes(needle) ? "search-hit" : "",
    ].filter(Boolean);
    previousHl = hl;
    rows.push(
      // biome-ignore lint/a11y/useSemanticElements: cttc's rows are divs placed absolutely; a list item to assistive technology.
      <div
        key={i}
        className={classes.join(" ")}
        role="listitem"
        ref={(el) => {
          // cttc's rows are placed by script; the page's CSP forbids style attributes.
          if (el) el.style.top = `${i * ROW_HEIGHT}px`;
        }}
        title={`${new Date(ts).toISOString()}\n${row.text}`}
      >
        <span className="ts">{clock(ts)}</span>
        {row.text.split("\n")[0]}
      </div>,
    );
  }

  const find = async (forward: boolean) => {
    if (!query) {
      setStatus("");
      return;
    }
    const from = matchIndex ?? (forward ? -1 : total);
    const r = await findRow(
      request,
      source,
      view,
      order,
      query,
      from,
      forward ? "next" : "previous",
    );
    inputRef.current?.focus();
    if (!r.ok) return setStatus(r.message);
    if (r.index === null) return setStatus("no matches");
    setStatus("");
    setMatchIndex(r.index);
    const body = bodyRef.current;
    if (body) {
      const top = Math.max(0, r.index * ROW_HEIGHT - body.clientHeight / 2 + ROW_HEIGHT / 2);
      body.scrollTop = top;
      setScrollTop(top);
    }
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void find(!e.shiftKey);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      void find(true);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      void find(false);
    } else if (e.key === "Escape") setSearching(false);
  };

  const entries: MenuEntry[] = [
    {
      label: "Search",
      icon: "search",
      onSelect: () => {
        setSearching((s) => !s);
        setTimeout(() => inputRef.current?.focus());
      },
    },
    {
      label: "Sort up",
      icon: "sort-up",
      active: order === "oldest",
      onSelect: () => onOrder("oldest"),
    },
    {
      label: "Sort down",
      icon: "sort-down",
      active: order === "newest",
      onSelect: () => onOrder("newest"),
    },
    { label: "Export", icon: "export", onSelect: onExport },
  ];

  return (
    <section className="panel" aria-label={`Logs of ${name}`}>
      <div className="panel-head">
        <div className="panel-head-top">
          <button
            type="button"
            className="icon-btn panel-menu-btn"
            title="Menu"
            aria-label="Menu"
            aria-haspopup="true"
            aria-expanded={menu !== null}
            onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
          >
            <Icon name="menu" />
          </button>
          <div className="panel-head-center">
            <span className="name" title={source}>
              {name}
            </span>
          </div>
          <div className="panel-head-right">
            <button
              type="button"
              className="close"
              title="Hide this container's logs and charts; collection goes on"
              aria-label={`Hide ${name}`}
              onClick={onHide}
            >
              ✕
            </button>
          </div>
        </div>
        <div className="panel-head-controls">
          <span className="muted">{`${total.toLocaleString()} entries`}</span>
        </div>
      </div>
      <div className="panel-search" hidden={!searching}>
        <input
          ref={inputRef}
          type="text"
          placeholder="search…"
          aria-label={`Search the logs of ${name}`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setMatchIndex(null);
          }}
          onKeyDown={onSearchKey}
        />
        <button type="button" title="Previous match" onClick={() => void find(false)}>
          ▲
        </button>
        <button type="button" title="Next match" onClick={() => void find(true)}>
          ▼
        </button>
        <span className="muted search-status" role="status">
          {status}
        </span>
        <button type="button" title="Close search" onClick={() => setSearching(false)}>
          ✕
        </button>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: cttc's scrolling body; a list to assistive technology. */}
      <div
        className="panel-body"
        ref={bodyRef}
        role="list"
        aria-label={`${name}: ${total} entries`}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div
          className="panel-spacer"
          ref={(el) => {
            if (el) el.style.height = `${total * ROW_HEIGHT}px`;
          }}
        />
        {rows}
      </div>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={entries}
          label={`${name}'s log`}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </section>
  );
}
