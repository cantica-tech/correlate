/**
 * cttc's switch (REQ-000020-sJpO9KMY Requirement 1): a real checkbox, so the
 * keyboard and screen readers work as for any checkbox, drawn as cttc's
 * track and thumb, inside a clickable label (`.ctl.switch-row`).
 */
import type { ReactNode } from "react";

/** The switch's props. */
export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** The label beside the switch, which also toggles it. */
  children: ReactNode;
  id?: string;
  disabled?: boolean;
  title?: string;
}

/** An on/off switch with its label. */
export function Switch({ checked, onChange, children, id, disabled, title }: SwitchProps) {
  return (
    <label className="ctl switch-row" title={title}>
      <span className="switch">
        <input
          id={id}
          type="checkbox"
          role="switch"
          aria-checked={checked}
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span className="switch-track">
          <span className="switch-thumb" />
        </span>
      </span>
      <span>{children}</span>
    </label>
  );
}
