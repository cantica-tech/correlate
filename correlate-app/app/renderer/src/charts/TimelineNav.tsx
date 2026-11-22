/**
 * cttc's timeline navigator (`index.html:240-245`, `attachTimelineNav`
 * `app.js:2140-2180`; REQ-000031-sJpO9KMY): the thumb shows the view within
 * the data and now, dragged (or moved with the arrow keys) to pan; a click
 * on the track centres there; "now" goes live again at the default span.
 * The container charts' (`#chart-nav`) and the host's (`#host-nav`,
 * REQ-000032-sJpO9KMY) are two of these on one view.
 */
import { type MouseEvent as ReactMouseEvent, useRef } from "react";
import type { Viewport } from "../correlate/atoms.js";
import { panBy } from "../correlate/zoom.js";
import { thumbOf, viewAtTrack, viewDragged } from "./viewState.js";

/** The navigator's props. */
export interface TimelineNavProps {
  /** `chart-nav` or `host-nav`. */
  id: string;
  view: Viewport;
  /** The view when a drag starts (it may have moved since the last render). */
  currentView: () => Viewport;
  bounds: { lo: number; hi: number };
  live: boolean;
  /** A pause counts down to live again. */
  resuming: boolean;
  hidden?: boolean;
  /**
   * The "now" label; left out in the analysis view, where nothing goes to the
   * present (br-ANLYS-000002-sJpO9KMY, cttc bug 16).
   */
  showNow?: boolean;
  /** A pan that is read at once (the track, the keys). */
  onPan: (view: Viewport) => void;
  /** A thumb drag in progress; `onPanned` when it ends. */
  onDrag: (view: Viewport) => void;
  onPanned: () => void;
  onNow: () => void;
}

/** A navigator. */
export function TimelineNav(props: TimelineNavProps) {
  const { id, view, bounds, live } = props;
  const trackRef = useRef<HTMLDivElement>(null);

  // The thumb is placed by script (the page's CSP forbids style attributes).
  const placeThumb = (el: HTMLDivElement | null) => {
    const width = trackRef.current?.clientWidth ?? 0;
    if (!el || !width) return;
    const thumb = thumbOf(view, bounds, width);
    el.style.left = `${thumb.left}px`;
    el.style.width = `${thumb.width}px`;
  };
  const dragThumb = (e: ReactMouseEvent) => {
    e.stopPropagation();
    const startX = e.clientX;
    const start = props.currentView();
    const width = trackRef.current?.clientWidth ?? 1;
    const fixed = bounds;
    const move = (ev: MouseEvent) =>
      props.onDrag(viewDragged(start, fixed, ev.clientX - startX, width));
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      props.onPanned();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      id={id}
      className="timeline-nav"
      hidden={props.hidden}
      title="Drag the thumb or click the track to pan · click “now” to jump to the present and resume following it"
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the thumb's arrow keys pan from the keyboard. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: cttc's track; the thumb is the slider. */}
      <div
        className="tl-track"
        ref={trackRef}
        onClick={(e) => {
          if (e.target !== e.currentTarget) return;
          const rect = e.currentTarget.getBoundingClientRect();
          props.onPan(viewAtTrack(view, bounds, (e.clientX - rect.left) / rect.width));
        }}
      >
        <div
          className="tl-thumb"
          ref={placeThumb}
          role="slider"
          tabIndex={0}
          aria-label="The view in time"
          aria-valuemin={bounds.lo}
          aria-valuemax={bounds.hi}
          aria-valuenow={view.t0}
          aria-valuetext={`${new Date(view.t0).toLocaleTimeString()} to ${new Date(view.t1).toLocaleTimeString()}`}
          onMouseDown={dragThumb}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            props.onPan(panBy(view, e.key === "ArrowLeft" ? -0.1 : 0.1));
          }}
        />
        {props.showNow === false ? null : (
          // biome-ignore lint/a11y/useSemanticElements: cttc's now label is a span; a button to assistive technology.
          <span
            className="tl-now-label"
            data-live={String(live)}
            role="button"
            tabIndex={0}
            title={
              !live && props.resuming
                ? "Live tracking paused -- see the status bar for the resume countdown, or click to jump now"
                : live
                  ? "Following the present -- click to jump anyway"
                  : "Jump back to the present and resume following it"
            }
            onClick={(e) => {
              e.stopPropagation();
              props.onNow();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                props.onNow();
              }
            }}
          >
            now
          </span>
        )}
      </div>
    </div>
  );
}
