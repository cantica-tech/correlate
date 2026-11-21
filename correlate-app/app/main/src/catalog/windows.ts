/**
 * One active Sump per window (br-SUMP-000010-sJpO9KMY, REQ-000012-sJpO9KMY
 * Requirement 3, decision D2). Each window starts on the Sump the last window
 * made active, else the local Sump; changing one window's Sump changes no
 * other window's. Windows are known by their `webContents` id, which is what
 * an IPC call says it came from.
 */
import { type Catalog, LOCAL_ID } from "./catalog.js";

/** What the renderer learns about its window's Sump. */
export interface ActiveSump {
  id: string;
  name: string;
  kind: "local" | "remote";
}

export class ActiveSumps {
  /** Each window's Sump; `null` for a window on none (after an uninstall). */
  private readonly byWindow = new Map<number, string | null>();

  constructor(private readonly catalog?: Catalog) {}

  /**
   * A window opened: it starts on the last active Sump, else the local one
   * (unless the local Sump was uninstalled: then on none).
   */
  open(windowId: number): string | null {
    const localRetired = this.catalog?.get(LOCAL_ID)?.retiredAt !== undefined;
    const id = this.catalog?.lastActive() ?? (localRetired ? null : LOCAL_ID);
    this.byWindow.set(windowId, id);
    return id;
  }

  /** Put a window on no Sump (its Sump was uninstalled and none other answers). */
  clear(windowId: number): void {
    this.byWindow.set(windowId, null);
  }

  /** The windows whose active Sump is `sumpId`. */
  windowsOn(sumpId: string): number[] {
    return [...this.byWindow].filter(([, id]) => id === sumpId).map(([window]) => window);
  }

  /** A window closed. */
  close(windowId: number): void {
    this.byWindow.delete(windowId);
  }

  /** The window's active Sump id, if the window is known. */
  get(windowId: number): string | undefined {
    return this.byWindow.get(windowId) ?? undefined;
  }

  /**
   * Make `sumpId` the window's active Sump. It must be in the catalog and not
   * retired (or be the local Sump); it becomes the one new windows start on.
   */
  set(windowId: number, sumpId: string): void {
    const entry = this.catalog?.get(sumpId);
    const retired = entry?.retiredAt !== undefined;
    if ((sumpId !== LOCAL_ID && !entry) || (entry && retired)) {
      throw new Error(`no Sump ${sumpId} to make active`);
    }
    this.byWindow.set(windowId, sumpId);
    if (entry) this.catalog?.setLastActive(sumpId);
  }

  /** The window's active Sump as the renderer sees it, or `null`. */
  describe(windowId: number): ActiveSump | null {
    const id = this.byWindow.get(windowId);
    if (id === undefined || id === null) return null;
    const entry = this.catalog?.get(id);
    if (entry) return { id, name: entry.name, kind: entry.kind };
    return id === LOCAL_ID ? { id, name: "This machine", kind: "local" } : null;
  }
}
