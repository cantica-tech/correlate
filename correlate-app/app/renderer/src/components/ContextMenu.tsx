/**
 * cttc's context menu (`shared/ctx-menu`, REQ-000022-sJpO9KMY Requirement 3):
 * `#ctxmenu` at the pointer, entries with an optional icon, separators,
 * disabled entries; arrow keys move between entries, Escape or a click
 * elsewhere closes it and gives focus back to what had it. Drawn in
 * `<body>`, as cttc appended it there, so it takes the page's type, not
 * that of what was right-clicked (the status bar's is smaller).
 */
import { type KeyboardEvent, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../icons/Icon.js";

/** One entry, or a separator. */
export type MenuEntry =
  | {
      label: string;
      onSelect: () => void;
      icon?: IconName;
      disabled?: boolean;
      title?: string;
      /** The current choice of several, marked as cttc's (`data-active`). */
      active?: boolean;
    }
  | "separator";

/** The menu's props. */
export interface ContextMenuProps {
  /** Where it opens, in the window's pixels. */
  x: number;
  y: number;
  entries: readonly MenuEntry[];
  onClose: () => void;
  /** What the menu is about, for screen readers. */
  label: string;
}

/** A context menu, open while it is drawn. */
export function ContextMenu({ x, y, entries, onClose, label }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current();
    };
    const onEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", onEscape);
      opener?.focus();
    };
  }, []);

  // Keep it inside the window, as cttc's floating-ui placement did.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`;
    el.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height))}px`;
  }, [x, y]);

  const move = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []),
    ];
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  const menu = (
    <div id="ctxmenu" ref={ref} role="menu" aria-label={label} tabIndex={-1} onKeyDown={move}>
      {entries.map((entry, i) =>
        entry === "separator" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity but their place.
          <div className="ctxmenu-sep" aria-hidden={true} key={`sep-${i}`} />
        ) : (
          <button
            type="button"
            role="menuitem"
            key={entry.label}
            disabled={entry.disabled}
            title={entry.title}
            data-active={entry.active ? "true" : undefined}
            onClick={() => {
              onClose();
              entry.onSelect();
            }}
          >
            {entry.icon ? <Icon name={entry.icon} className="ctxmenu-icon" /> : null}
            <span>{entry.label}</span>
          </button>
        ),
      )}
    </div>
  );
  // In a test without a document (server rendering), it is drawn in place.
  return typeof document === "undefined" ? menu : createPortal(menu, document.body);
}
