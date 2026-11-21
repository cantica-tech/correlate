/**
 * One icon of the set (REQ-000019-sJpO9KMY), drawn inline at `1em` in the
 * text color, so it follows light and dark mode like cttc's inline SVGs
 * (br-STYLE-000001-sJpO9KMY). Decorative unless given a `label`: then it is
 * announced as an image with that label.
 */
import { ICONS, type IconName } from "./icons.generated.js";
import "./icons.css";

export type { IconName };

export interface IconProps {
  name: IconName;
  /** What the icon says, for screen readers; leave it out when the text next to it says it. */
  label?: string;
  className?: string;
}

export function Icon({ name, label, className }: IconProps) {
  const classes = className ? `icon ${className}` : "icon";
  if (label) {
    return (
      <span
        className={classes}
        role="img"
        aria-label={label}
        // biome-ignore lint/security/noDangerouslySetInnerHtml: the markup is the app's own committed, cleaned icon files, held clean by icons.test.ts.
        dangerouslySetInnerHTML={{ __html: ICONS[name].replace(' aria-hidden="true"', "") }}
      />
    );
  }
  return (
    <span
      className={classes}
      aria-hidden={true}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the markup is the app's own committed, cleaned icon files, held clean by icons.test.ts.
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}
