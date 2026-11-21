/**
 * cttc's bordered panel (REQ-000020-sJpO9KMY Requirement 1): `.panel`, with
 * an optional `.panel-head` whose title is centered between whatever sits on
 * either side, and a body.
 */
import type { ReactNode } from "react";

/** The panel's props. */
export interface PanelProps {
  /** The centered title of its head; no head when left out. */
  title?: ReactNode;
  /** Controls at the right of the head (`.panel-head-right`). */
  controls?: ReactNode;
  /** Its body's own class: cttc's `.panel-body` is monospace, for logs. */
  bodyClassName?: string;
  id?: string;
  className?: string;
  children?: ReactNode;
}

/** A bordered panel with an optional head. */
export function Panel({ title, controls, bodyClassName, id, className, children }: PanelProps) {
  return (
    <section className={className ? `panel ${className}` : "panel"} id={id}>
      {title !== undefined || controls ? (
        <div className="panel-head">
          <div className="panel-head-top">
            {title !== undefined ? <span className="panel-head-title">{title}</span> : null}
            {controls ? <div className="panel-head-right">{controls}</div> : null}
          </div>
        </div>
      ) : null}
      <div className={bodyClassName ?? "panel-body"}>{children}</div>
    </section>
  );
}
