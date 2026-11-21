/**
 * cttc's segmented control (REQ-000020-sJpO9KMY Requirement 1): every
 * option always visible and enabled, the chosen one highlighted
 * (`.btn-group.seg-control`, `data-active="true"`), unlike a switch, which
 * reads one side as "off".
 */
import type { ReactNode } from "react";
import { Icon, type IconName } from "../icons/Icon.js";

/** One option of the control. */
export interface SegOption<T extends string> {
  value: T;
  label: ReactNode;
  /** An icon before the label, in `.seg-icon`. */
  icon?: IconName;
  title?: string;
}

/** The control's props. */
export interface SegControlProps<T extends string> {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** What the group chooses, for screen readers. */
  label: string;
  id?: string;
}

/** A row of buttons, one chosen. */
export function SegControl<T extends string>({
  options,
  value,
  onChange,
  label,
  id,
}: SegControlProps<T>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: cttc's markup is a span; a fieldset brings its own border and padding.
    <span className="btn-group seg-control" role="group" aria-label={label} id={id}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            data-active={active ? "true" : undefined}
            aria-pressed={active}
            title={option.title}
            onClick={() => onChange(option.value)}
          >
            {option.icon ? <Icon name={option.icon} className="seg-icon" /> : null}
            {option.label}
          </button>
        );
      })}
    </span>
  );
}
