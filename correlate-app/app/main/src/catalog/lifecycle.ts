/**
 * The Sump lifecycle (br-SUMP-000011-sJpO9KMY, REQ-000013-sJpO9KMY).
 *
 * Every Sump is in exactly one state, held here and nowhere else; the
 * renderer only reads it. The only transitions (decided in
 * FEAT-000014-sJpO9KMY):
 *
 *     provisioning → active | retired
 *     active       → unreachable | retired
 *     unreachable  → active | retired
 *     retired      (final)
 *
 * States live in the main process's memory, seeded from the catalog at start:
 * live Sumps are `unreachable` until they answer, retired ones `retired`. A
 * Sump being provisioned exists only here until its first connect records it
 * in the catalog (br-SUMP-000001-sJpO9KMY).
 */
import type { Catalog } from "./catalog.js";

/** A Sump's lifecycle state. */
export type SumpState = "provisioning" | "active" | "unreachable" | "retired";

/** The states each state may move to. */
export const TRANSITIONS: Readonly<Record<SumpState, readonly SumpState[]>> = {
  provisioning: ["active", "retired"],
  active: ["unreachable", "retired"],
  unreachable: ["active", "retired"],
  retired: [],
};

/** Every state, in lifecycle order. */
export const STATES: readonly SumpState[] = ["provisioning", "active", "unreachable", "retired"];

/** One Sump's state: since when, and why. */
export interface StateRecord {
  id: string;
  state: SumpState;
  since: string;
  reason: string;
}

/** A transition the lifecycle does not allow. */
export class TransitionError extends Error {
  override readonly name = "TransitionError";

  constructor(
    readonly id: string,
    readonly from: SumpState | undefined,
    readonly to: SumpState,
  ) {
    super(
      from === undefined
        ? `Sump ${id} is not known; it cannot become ${to}`
        : `Sump ${id} cannot go from ${from} to ${to}`,
    );
  }
}

/** Hears every state change. */
export type StateListener = (record: StateRecord) => void;

/** Where transitions are logged. */
export interface LifecycleLogger {
  info(message: string): void;
}

export class Lifecycle {
  private readonly records = new Map<string, StateRecord>();
  private readonly listeners = new Set<StateListener>();

  /** Seed from the catalog: live Sumps `unreachable`, retired ones `retired`. */
  constructor(
    private readonly catalog?: Catalog,
    private readonly clock: () => Date = () => new Date(),
    private readonly logger: LifecycleLogger = console,
  ) {
    const at = this.clock().toISOString();
    for (const entry of catalog?.list({ retired: true }) ?? []) {
      const retired = entry.retiredAt !== undefined;
      this.records.set(entry.id, {
        id: entry.id,
        state: retired ? "retired" : "unreachable",
        since: retired ? (entry.retiredAt as string) : at,
        reason: retired ? "retired in the catalog" : "not reached yet",
      });
    }
  }

  /** Every Sump's state. */
  states(): StateRecord[] {
    return [...this.records.values()].map((r) => ({ ...r }));
  }

  /** One Sump's state, if known. */
  get(id: string): StateRecord | undefined {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  /** Hear every change; returns the function that stops listening. */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A new Sump starts being provisioned; refused for a Sump already known. */
  provision(id: string, reason = "provisioning started"): StateRecord {
    if (this.records.has(id))
      throw new TransitionError(id, this.records.get(id)?.state, "provisioning");
    return this.set(id, "provisioning", reason);
  }

  /**
   * Move a Sump to `to`, if the lifecycle allows it. Reporting the state it
   * is already in changes nothing. Retiring a catalog Sump retires it there
   * too.
   */
  move(id: string, to: SumpState, reason: string): StateRecord {
    const current = this.records.get(id);
    if (current?.state === to) return { ...current };
    if (!current || !TRANSITIONS[current.state].includes(to)) {
      throw new TransitionError(id, current?.state, to);
    }
    if (to === "retired" && this.catalog?.get(id)) this.catalog.retire(id, this.clock());
    return this.set(id, to, reason);
  }

  /** The Sump answered: `active`. A Sump not known yet is added first. */
  reachable(id: string, reason: string): StateRecord | undefined {
    return this.observed(id, "active", reason);
  }

  /** The Sump did not answer: `unreachable`. */
  unreachable(id: string, reason: string): StateRecord | undefined {
    return this.observed(id, "unreachable", reason);
  }

  /**
   * An observed outcome. Sumps not known yet (just recorded in the catalog,
   * or the development fallback) are added as `unreachable` first; retired
   * and provisioning Sumps are left alone by observations.
   */
  private observed(id: string, to: "active" | "unreachable", reason: string) {
    const current = this.records.get(id);
    if (!current) this.set(id, "unreachable", "first seen");
    else if (current.state === "retired") return undefined;
    else if (current.state === "provisioning" && to === "unreachable") return undefined;
    return this.move(id, to, reason);
  }

  private set(id: string, state: SumpState, reason: string): StateRecord {
    const record: StateRecord = { id, state, since: this.clock().toISOString(), reason };
    this.records.set(id, record);
    this.logger.info(`Sump ${id}: ${state} (${reason})`);
    for (const listener of this.listeners) listener({ ...record });
    return { ...record };
  }
}
