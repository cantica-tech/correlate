/**
 * One log panel (REQ-000029-sJpO9KMY Requirement 2, br-LOGV-000001-sJpO9KMY),
 * in cttc's markup (`Panel`, `app.js:2360-2700`): the head (menu, name, row
 * count), the search bar, and `.panel-body` of 22 px `.log-row`s, only those
 * in view drawn (`logWindow`), their 200-row pages fetched on demand
 * (`PageCache`). Rows within the highlight window of the cursor are marked as
 * cttc's runs (`hl`, `hl-top`, `hl-bottom`).
 *
 * The cursor (REQ-000030-sJpO9KMY): when it moves, the panel scrolls its row
 * nearest the cursor to its middle and marks it (cttc's `jumpTo`); a click on
 * a row, or Enter on it, sets the cursor there and recentres the charts; a
 * search match sets it too. When only the view moves, the rows under the eye
 * stay put. The head drags onto another panel's, or a legend entry, to move it.
 */
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { DRAG_TYPE } from "../charts/arrange.js";
import { ContextMenu, type MenuEntry } from "../components/index.js";
import type { Viewport } from "../correlate/atoms.js";
import { visibleRange } from "../correlate/logWindow.js";
import { isHighlighted } from "../correlate/timeMapping.js";
import { Icon } from "../icons/Icon.js";
import type { SumpRequester } from "../shell/bridge.js";
import { clock, findRow, levelOf, nearestRow, type Order, pageFetcher } from "./api.js";
import { PAGE, PageCache } from "./pages.js";

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
  /** The window's cursor, or null. */
  cursorT?: number | null;
  /** How far from the cursor a row is highlighted, in ms: cttc's 5 s. */
  windowMs?: number;
  /** A search match sets the cursor. */
  onCursor?: (t: number) => void;
  /** A row's click sets the cursor and recentres the charts. */
  onRowClick?: (t: number) => void;
  /** Another container dropped on this panel's head moves there. */
  onReorder?: (dragged: string) => void;
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
  windowMs = 5_000,
  onExport,
  onHide,
  onCursor,
  onRowClick,
  onReorder,
}: LogPanelProps) {
  const [, setTick] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("");
  const [cursorIdx, setCursorIdxState] = useState<number | null>(null);
  const cursorIdxRef = useRef<number | null>(null);
  const setCursorIdx = (index: number | null) => {
    cursorIdxRef.current = index;
    setCursorIdxState(index);
  };
  /** The cursor this panel set itself (a row's click, a match): its row is already marked. */
  const own = useRef<number | null>(null);
  /** The cursor and view last followed. */
  const followed = useRef<{ t: number | null; view: Viewport | null }>({ t: null, view: null });
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
      cursorIdxRef.current = null;
      setCursorIdxState(null);
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

  /** Mark row `index` as the cursor's and scroll it to the middle. */
  function centre(index: number) {
    setCursorIdx(index);
    const body = bodyRef.current;
    if (!body) return;
    const top = Math.max(0, index * ROW_HEIGHT - body.clientHeight / 2 + ROW_HEIGHT / 2);
    body.scrollTop = top;
    setScrollTop(top);
  }

  // Follow the cursor (cttc's jumpTo): a cursor set elsewhere is centred; a
  // new view (5 s on, a recentre) finds the cursor's row again and moves
  // the scroll by as many rows as it moved, so the rows in sight stay put.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `centre` and the refs change with every render.
  useEffect(() => {
    if (cursorT === null) {
      followed.current = { t: null, view };
      setCursorIdx(null);
      return;
    }
    const previous = followed.current;
    followed.current = { t: cursorT, view };
    const moved = previous.t !== cursorT;
    if (moved && own.current === cursorT && previous.view === view) return;
    let live = true;
    void nearestRow(request, source, view, order, cursorT).then((r) => {
      if (!live) return;
      if (!r.ok) {
        console.warn(`the row nearest the cursor in ${source}: ${r.message}`);
        return setStatus(r.message);
      }
      if (r.index === null) return setCursorIdx(null);
      const before = cursorIdxRef.current;
      const body = bodyRef.current;
      if ((moved && own.current !== cursorT) || before === null || !body) return centre(r.index);
      if (r.index === before) return;
      const top = Math.max(0, body.scrollTop + (r.index - before) * ROW_HEIGHT);
      setCursorIdx(r.index);
      body.scrollTop = top;
      setScrollTop(top);
    });
    return () => {
      live = false;
    };
  }, [cursorT, view, order, source, request]);

  /** A row's click: the cursor at its time, the charts recentred. */
  const pick = (index: number, ts: number) => {
    own.current = ts;
    setCursorIdx(index);
    onRowClick?.(ts);
  };

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
      i === cursorIdx ? "cursor-row" : "",
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
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a row is clicked, or Enter pressed on it, to set the cursor.
        tabIndex={0}
        onClick={() => pick(i, ts)}
        onKeyDown={(e) => {
          if (e.key === "Enter") pick(i, ts);
        }}
        ref={(el) => {
          // cttc's rows are placed by script; the page's CSP forbids style attributes.
          if (el) el.style.top = `${i * ROW_HEIGHT}px`;
        }}
        title={`${new Date(ts).toISOString()}\n${row.text}\n(click to set the cursor here)`}
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
    const from = cursorIdx ?? (forward ? -1 : total);
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
    centre(r.index);
    // The match sets the cursor, as cttc's jumpToIndex, for the charts and the other panels.
    const index = r.index;
    const row =
      cache.row(index) ??
      (await pageFetcher(request, source, view, order)(Math.floor(index / PAGE)).catch(() => null))
        ?.rows[index % PAGE];
    if (row) {
      own.current = Date.parse(row.ts);
      onCursor?.(own.current);
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: cttc's head drags to reorder; the legend's Alt+arrows do it from the keyboard. */}
      <div
        className="panel-head"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_TYPE, name);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData(DRAG_TYPE);
          if (!dragged || dragged === name) return;
          e.preventDefault();
          onReorder?.(dragged);
        }}
      >
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
          onChange={(e) => setQuery(e.target.value)}
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
