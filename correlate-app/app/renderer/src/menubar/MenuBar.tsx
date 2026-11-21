/**
 * cttc's menu bar (REQ-000023-sJpO9KMY Requirements 1 and 3), in cttc's
 * markup (`index.html:15-73`) so cttc's rules in `menubar.css` style it,
 * and behaving as cttc's (`app.js:4307-4345`): a label opens its menu and
 * closes it again; with one open, hovering another label moves to it; an
 * entry runs and closes; Escape or a click elsewhere closes. Entries run in
 * the main process on this window (`menu.action`). Pressing an entry or a
 * label does not take focus, so Cut, Copy and Paste act on the field that
 * had it. The window's own shortcuts run here too.
 */
import { useEffect, useRef, useState } from "react";
import { Icon } from "../icons/Icon.js";
import { NOT_YET } from "../shell/sections.js";
import { accText, MENUS, type MenuItem, shortcutFor } from "./menus.js";

/** Whether this is macOS, for the shortcut text and modifier, as cttc's `IS_MAC`. */
export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);

/** The menu bar's props. */
export interface MenuBarProps {
  /** Runs an entry by name. */
  onAction: (action: string) => void;
  /** macOS's ⌘, or Ctrl elsewhere. */
  mac?: boolean;
}

/** Keep focus where it is when an entry or a label is pressed. */
const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();

/** The menu bar. */
export function MenuBar({ onAction, mac = IS_MAC }: MenuBarProps) {
  const [open, setOpen] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const outside = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(null);
    };
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") return setOpen(null);
      const action = shortcutFor(e, mac);
      if (action) {
        e.preventDefault();
        onAction(action);
      }
    };
    document.addEventListener("click", outside);
    window.addEventListener("keydown", keys);
    return () => {
      document.removeEventListener("click", outside);
      window.removeEventListener("keydown", keys);
    };
  }, [mac, onAction]);

  const entry = (item: MenuItem) => {
    const label = item.icon ? (
      <span className="menu-item-label">
        <Icon name={item.icon} className="ctxmenu-icon" />
        {item.label}
      </span>
    ) : (
      item.label
    );
    return (
      <button
        type="button"
        role="menuitem"
        key={item.action}
        data-action={item.action}
        className={item.indent ? "menu-indent" : undefined}
        disabled={item.later}
        title={item.later ? `${item.title} (${NOT_YET})` : item.title}
        onMouseDown={keepFocus}
        onClick={() => {
          setOpen(null);
          onAction(item.action);
        }}
      >
        {label}
        {item.acc ? <span className="acc">{accText(item.acc, mac)}</span> : null}
      </button>
    );
  };

  return (
    <nav id="menubar" ref={ref} aria-label="Application menu">
      {MENUS.map((menu) => (
        <div className={open === menu.id ? "menu open" : "menu"} data-menu={menu.id} key={menu.id}>
          <button
            className="menu-label"
            type="button"
            aria-haspopup="menu"
            aria-expanded={open === menu.id}
            onMouseDown={keepFocus}
            onClick={() => setOpen(open === menu.id ? null : menu.id)}
            onMouseEnter={() => {
              if (open && open !== menu.id) setOpen(menu.id);
            }}
          >
            {menu.label}
          </button>
          <div className="menu-list" role="menu" aria-label={menu.label}>
            {menu.items.map((line, i) =>
              line === "separator" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity but their place.
                <div className="menu-sep" key={`sep-${i}`} />
              ) : "subLabel" in line ? (
                <div className="menu-sub-label" key={line.subLabel}>
                  {line.subLabel}
                </div>
              ) : (
                entry(line)
              ),
            )}
          </div>
        </div>
      ))}
    </nav>
  );
}
