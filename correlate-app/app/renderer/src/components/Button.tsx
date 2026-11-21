/**
 * cttc's button (REQ-000020-sJpO9KMY Requirement 1): a plain `<button>` in
 * cttc's default look, or one of its three kinds, styled by cttc's own rules
 * in `components.css`.
 */
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon } from "../icons/Icon.js";

/** Which of cttc's buttons: `primary` (`button.primary`), `fetch` (`.btn-fetch`), `danger` (`.btn-danger`). */
export type ButtonKind = "default" | "primary" | "fetch" | "danger";

/** The button's props: those of `<button>`, and its kind. */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  /** The look; `default` when left out. */
  kind?: ButtonKind;
  /** `submit` only inside a form that should submit; `button` otherwise. */
  type?: "button" | "submit";
  children?: ReactNode;
}

const CLASS: Record<ButtonKind, string | undefined> = {
  default: undefined,
  primary: "primary",
  fetch: "btn-fetch",
  danger: "btn-danger",
};

/** A button; `fetch` carries cttc's fetch icon before its label. */
export function Button({
  kind = "default",
  type = "button",
  className,
  children,
  ...rest
}: ButtonProps) {
  const classes = [CLASS[kind], className].filter(Boolean).join(" ") || undefined;
  return (
    <button type={type} className={classes} {...rest}>
      {kind === "fetch" ? <Icon name="fetch" className="btn-fetch-icon" /> : null}
      {children}
    </button>
  );
}
