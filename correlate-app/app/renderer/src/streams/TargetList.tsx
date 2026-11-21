/**
 * The picker's checklist (REQ-000025-sJpO9KMY Requirement 4), cttc's
 * `#docker-targets` (`set-dialog.ts:282-372`): a group per kind (Swarm
 * services, Containers), its header selecting or clearing all of it; each
 * target a checkbox with cttc's ✔ mark; a followed target that is gone
 * shown checked, disabled, 🚫 and "no longer available", and left out of what
 * is sent, as cttc did.
 */
import type { Targets } from "./api.js";

/** A target's key in the checked set: `container:<name>` or `service:<name>`. */
export const keyOf = (type: "container" | "service", name: string) => `${type}:${name}`;

/** What is checked when the targets arrive: what is followed and still there. */
export function initialChecked(targets: Targets): Set<string> {
  const present = new Set([
    ...targets.containers.map((c) => keyOf("container", c.name)),
    ...(targets.services ?? []).map((s) => keyOf("service", s.name)),
  ]);
  const followed = [
    ...targets.followed.containers.map((n) => keyOf("container", n)),
    ...targets.followed.services.map((n) => keyOf("service", n)),
  ];
  return new Set(followed.filter((k) => present.has(k)));
}

/** What submitting sends: exactly what is checked among what is there. */
export function followedFrom(targets: Targets, checked: ReadonlySet<string>) {
  return {
    containers: targets.containers
      .map((c) => c.name)
      .filter((n) => checked.has(keyOf("container", n))),
    services: (targets.services ?? [])
      .map((s) => s.name)
      .filter((n) => checked.has(keyOf("service", n))),
  };
}

interface Item {
  name: string;
  extra: string;
}

/** The checklist's props. */
export interface TargetListProps {
  targets: Targets;
  checked: ReadonlySet<string>;
  onChange: (checked: Set<string>) => void;
}

/** The checklist. */
export function TargetList({ targets, checked, onChange }: TargetListProps) {
  const containerNames = new Set(targets.containers.map((c) => c.name));
  const serviceNames = new Set((targets.services ?? []).map((s) => s.name));
  const group = (
    title: string,
    type: "container" | "service",
    items: Item[],
    missing: string[],
  ) => {
    if (!items.length && !missing.length) return null;
    const keys = items.map((it) => keyOf(type, it.name));
    const toggleAll = () => {
      const next = new Set(checked);
      const selectAll = keys.some((k) => !next.has(k));
      for (const k of keys) {
        if (selectAll) next.add(k);
        else next.delete(k);
      }
      onChange(next);
    };
    return (
      <>
        {/* biome-ignore lint/a11y/useSemanticElements: cttc's group header is a div; it is a button to assistive technology. */}
        <div
          className="group"
          title="Click to select/deselect all of this group"
          role="button"
          tabIndex={0}
          onClick={toggleAll}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggleAll();
            }
          }}
        >
          {title}
        </div>
        {items.map((it) => {
          const key = keyOf(type, it.name);
          const on = checked.has(key);
          return (
            <label key={key}>
              <input
                type="checkbox"
                value={it.name}
                data-type={type}
                checked={on}
                onChange={() => {
                  const next = new Set(checked);
                  if (on) next.delete(key);
                  else next.add(key);
                  onChange(next);
                }}
              />
              <span className="mark">{on ? "✔" : ""}</span> {it.name}{" "}
              <span className="tdoc">{it.extra}</span>
            </label>
          );
        })}
        {missing.map((name) => (
          <label key={`gone:${type}:${name}`} className="unavailable">
            <input type="checkbox" value={name} data-type={type} checked disabled readOnly />
            <span className="mark">🚫</span> {name}{" "}
            <span className="tdoc">no longer available</span>
          </label>
        ))}
      </>
    );
  };
  const goneServices = targets.followed.services.filter((n) => !serviceNames.has(n));
  const goneContainers = targets.followed.containers.filter((n) => !containerNames.has(n));
  const services = (targets.services ?? []).map((s) => ({ name: s.name, extra: s.replicas }));
  const containers = targets.containers.map((c) => ({ name: c.name, extra: c.image }));
  const nothing =
    !services.length && !containers.length && !goneServices.length && !goneContainers.length;
  return (
    <div id="docker-targets">
      {group("Swarm services (docker service logs)", "service", services, goneServices)}
      {group("Containers (docker logs)", "container", containers, goneContainers)}
      {nothing ? <div className="muted">Nothing is running there.</div> : null}
    </div>
  );
}
