/**
 * The parts of `window.correlate` (preload.cjs) the shell uses: the theme and
 * the sidebar's layout and actions (REQ-000018-sJpO9KMY, REQ-000021-sJpO9KMY).
 * Types only; the main process checks every value.
 */

/** Where the sidebar sits. */
export type Dock = "left" | "right" | "detached";
/** The sidebar's sections. */
export type Section = "sump" | "projects" | "events";

/** The sidebar's layout, as `main/src/sidebar.ts` keeps it. */
export interface SidebarLayout {
  dock: Dock;
  lastDock: "left" | "right";
  width: number;
  collapsed: boolean;
  expanded: Record<Section, boolean>;
}

/** A change of part of the layout. */
export type LayoutChange = Partial<Omit<SidebarLayout, "expanded">> & {
  expanded?: Partial<Record<Section, boolean>>;
};

export type ThemeMode = "system" | "light" | "dark";

/** The bridge, as far as the shell goes. */
export interface ShellBridge {
  theme: {
    get(): Promise<ThemeMode>;
    set(mode: ThemeMode): Promise<{ ok: boolean }>;
  };
  sidebar: {
    get(): Promise<SidebarLayout>;
    set(change: LayoutChange): Promise<{ ok: boolean; layout?: SidebarLayout; message?: string }>;
    action(name: string): Promise<{ ok: boolean; message?: string }>;
    onLayout(listener: (layout: SidebarLayout) => void): () => void;
    onRun(listener: (name: string) => void): () => void;
  };
}

declare global {
  interface Window {
    correlate?: ShellBridge;
  }
}
