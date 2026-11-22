/**
 * cttc's sidebar (REQ-000021-sJpO9KMY Requirements 1 to 3), in cttc's markup
 * (`index.html:75-149`, `action-bar.html` for the detached one) so cttc's
 * rules in `shell.css` style it. It draws a layout and reports what the user
 * asks for; the main process keeps the layout.
 */
import type { CSSProperties, ReactNode } from "react";
import { Icon } from "../icons/Icon.js";
import type { LayoutChange, SidebarLayout } from "./bridge.js";
import { railArrow } from "./rail.js";
import { AVAILABLE, type Entry, NOT_YET, SECTIONS, SEPARATOR } from "./sections.js";

export { railArrow };

/** The sidebar's props. */
export interface SidebarProps {
  layout: SidebarLayout;
  /** In the detached window: Bring Back in place of the dock controls. */
  detached?: boolean;
  onChange: (change: LayoutChange) => void;
  onAction: (action: string) => void;
  /** The actions that work; the others are disabled. */
  available?: ReadonlySet<string>;
  /** The window's project, under the Projects section's entries (REQ-000035-sJpO9KMY). */
  projectTree?: ReactNode;
}

const DOCKS = [
  { to: "left", label: "◧", title: "Dock left" },
  { to: "right", label: "◨", title: "Dock right" },
] as const;

/** The sidebar. */
export function Sidebar({
  layout,
  detached = false,
  onChange,
  onAction,
  available = AVAILABLE,
  projectTree,
}: SidebarProps) {
  const entry = (e: Entry) => {
    const works = available.has(e.action);
    return (
      <button
        type="button"
        key={e.action}
        data-action={e.action}
        disabled={!works}
        title={works ? e.title : `${e.title} (${NOT_YET})`}
        onClick={() => onAction(e.action)}
      >
        <Icon name={e.icon} className="ab-icon" />
        {e.label}
      </button>
    );
  };
  const style: CSSProperties | undefined =
    !detached && !layout.collapsed && layout.dock !== "detached"
      ? { width: `${layout.width}px` }
      : undefined;
  return (
    <aside
      id="action-bar"
      className={detached ? "detached" : undefined}
      data-collapsed={detached ? undefined : String(layout.collapsed)}
      style={style}
    >
      <div className="ab-dock-controls">
        {detached ? (
          <button
            type="button"
            id="ab-redock"
            className="btn-flat"
            title="Bring back into the main window"
            onClick={() => onChange({ dock: layout.lastDock })}
          >
            <Icon name="bring-back" svgClassName="btn-flat-icon" />
            Bring Back
          </button>
        ) : (
          <>
            <button
              type="button"
              id="ab-collapse-toggle"
              className="ab-dock-btn"
              title={layout.collapsed ? "Show sidebar" : "Hide sidebar"}
              aria-expanded={!layout.collapsed}
              onClick={() => onChange({ collapsed: !layout.collapsed })}
            >
              {railArrow(layout)}
            </button>
            {DOCKS.map((d) => (
              <button
                type="button"
                key={d.to}
                className="ab-dock-btn"
                data-dock-to={d.to}
                data-current={String(layout.dock === d.to)}
                title={d.title}
                onClick={() => onChange({ dock: d.to })}
              >
                {d.label}
              </button>
            ))}
            <button
              type="button"
              className="ab-dock-btn ab-dock-popout"
              data-dock-to="detached"
              data-current={String(layout.dock === "detached")}
              title="Detach into its own window"
              onClick={() => onChange({ dock: "detached" })}
            >
              ⧉
            </button>
          </>
        )}
      </div>
      {SECTIONS.map((section) => {
        const open = layout.expanded[section.id];
        return (
          <div
            className="ab-group"
            data-section={section.id}
            data-expanded={String(open)}
            key={section.id}
          >
            <button
              type="button"
              className="ab-group-header"
              aria-expanded={open}
              onClick={() => onChange({ expanded: { [section.id]: !open } })}
            >
              <Icon name={section.icon} className="ab-group-icon" />
              <span className="ab-group-title">{section.title}</span>
              <span className="ab-chevron">▾</span>
            </button>
            <div className="ab-group-body" hidden={!open}>
              {section.entries.map((e, i) =>
                // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity but their place.
                e === SEPARATOR ? <div className="ab-sep" key={`sep-${i}`} /> : entry(e),
              )}
              {section.id === "projects" ? projectTree : null}
            </div>
          </div>
        );
      })}
      <div className="ab-group ab-group-flat">
        <button type="button" data-action="preferences" onClick={() => onAction("preferences")}>
          <Icon name="preferences-window" className="ab-icon" />
          <span className="ab-group-title">Preferences</span>
        </button>
      </div>
      <div className="ab-group ab-group-flat ab-group-bottom">
        <button type="button" data-action="about" onClick={() => onAction("about")}>
          <span className="ab-icon">ⓘ</span>
          About correlate-app
        </button>
      </div>
      <div className="ab-group ab-group-flat">
        <button type="button" data-action="quit" onClick={() => onAction("quit")}>
          <span className="ab-icon">⏻</span>
          Quit
        </button>
      </div>
    </aside>
  );
}
