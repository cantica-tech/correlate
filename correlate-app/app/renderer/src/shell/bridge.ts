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

/** A Sump's lifecycle state (br-SUMP-000011-sJpO9KMY). */
export type SumpState = "provisioning" | "active" | "unreachable" | "retired";

/** One Sump's state, as the main process keeps it. */
export interface StateRecord {
  id: string;
  state: SumpState;
  since: string;
  reason: string;
}

/** One Sump of `sump.list()`. */
export interface ListedSump {
  id: string;
  name: string;
  kind: "local" | "remote";
  sshTarget?: string;
  sshPort?: number;
  sumpPort: number;
  forwardUrl?: string;
  state: SumpState;
  /** This window is on it. */
  current: boolean;
}

/** What a switch answers: done, refused, or a confirmation needed first. */
export type SwitchResult = { ok: true; id: string } | { ok: false; step: string; message: string };

/** One notification. */
export interface Notice {
  at: string;
  text: string;
}

/** What windows hear of the feed. */
export type NoticeEvent = { type: "entry"; entry: Notice } | { type: "cleared" };

/** A failure of a call to a Sump, as the bridge gives it. */
export type SumpErrorInfo =
  | { kind: "timeout"; message: string; limit: "total" | "idle"; limitMs: number }
  | { kind: "http"; message: string; status: number; detail: unknown }
  | { kind: "login-needed"; message: string }
  | { kind: "refused" | "network"; message: string };

/** One call to the window's Sump: a method and a path, never a URL. */
export type SumpRequester = (message: {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
  query?: Record<string, string | number | boolean>;
  timeoutMs?: number;
}) => Promise<{ ok: true; value: unknown } | { ok: false; error: SumpErrorInfo }>;

/** An open file (REQ-000034-sJpO9KMY). */
export interface OpenInfo {
  path: string;
  label: string;
  from: number;
  to: number;
}

/** A window's open files and its active one: null shows live. */
export interface OpenList {
  files: OpenInfo[];
  active: string | null;
}

/** The recording session, as the main process tells it (REQ-000037-sJpO9KMY). */
export interface RecordingState {
  status: "idle" | "recording" | "paused" | "stopped";
  target: { sump: string; stream: string; containers: string[]; host: boolean } | null;
  segments: { from: number; to: number }[];
  segmentStart: number | null;
}

/** The window's project, as the main process answers (REQ-000035-sJpO9KMY). */
export interface ProjectState {
  ok: boolean;
  cancelled?: boolean;
  message?: string;
  refused?: string[];
  warnings?: string[];
  session: {
    file: string | null;
    name: string;
    dirty: boolean;
    isDefault: boolean;
    missing: string[];
    project: {
      name: string;
      folders: { id: string; name: string; parent: string | null }[];
      items: { id: string; path: string; folder: string | null }[];
      sump: { id: string; stream: string } | null;
      tracks: Record<string, Record<string, { delaySecs: number; hidden: boolean }>>;
    };
  };
  open: OpenList;
  recent: string[];
}

/** The live view's settings, as the main process keeps them (REQ-000031-sJpO9KMY). */
export interface LiveSettings {
  /** Rows this close to the cursor are highlighted, in s. */
  windowSecs: number;
  /** Live tracking: the cursor follows now while live. */
  liveTrack: boolean;
  /** Where live tracking puts the cursor, relative to now, in s; never positive. */
  liveTrackSecs: number;
  /** After a double-click pause, live again after this many s; 0 stays paused. */
  resumeSecs: number;
}

/** The bridge, as far as the shell goes. */
export interface ShellBridge {
  menu: {
    action(name: string): Promise<{ ok: boolean; message?: string }>;
  };
  /** This window's active data stream (REQ-000027-sJpO9KMY). */
  stream?: {
    active(): Promise<string | null>;
    setActive(stream: string): Promise<{ ok: boolean; message?: string }>;
  };
  /** The analysis view's open files (REQ-000033-sJpO9KMY, REQ-000034-sJpO9KMY). */
  analysis?: {
    list(): Promise<OpenList>;
    request: SumpRequester;
    close(): Promise<{ ok: boolean }>;
  };
  /** The window's project (REQ-000035-sJpO9KMY). */
  project?: {
    get(): Promise<ProjectState>;
    newProject(): Promise<ProjectState>;
    open(): Promise<ProjectState>;
    openFile(file: string): Promise<ProjectState>;
    save(): Promise<ProjectState>;
    saveAs(): Promise<ProjectState>;
    addFiles(): Promise<ProjectState>;
    addPaths(paths: string[]): Promise<ProjectState>;
    show(id: string): Promise<ProjectState>;
    change(change: Record<string, unknown> & { op: string }): Promise<ProjectState>;
    tracks(): Promise<{
      item: string | null;
      tracks: Record<string, { delaySecs: number; hidden: boolean }>;
    }>;
  };
  /** The recording session (REQ-000037-sJpO9KMY). */
  recording?: {
    get(): Promise<RecordingState>;
    start(target?: {
      stream: string;
      containers: string[];
      host: boolean;
    }): Promise<RecordingState>;
    pause(): Promise<RecordingState>;
    stop(): Promise<RecordingState>;
    onChanged(listener: (state: RecordingState) => void): () => void;
  };
  /** Files the OS handed the app (REQ-000036-sJpO9KMY). */
  opened?: {
    take(): Promise<{ files: string[]; ignored: string[] }>;
    onFiles(listener: (arrived: { files: string[]; ignored: string[] }) => void): () => void;
  };
  /** The live view's settings (REQ-000031-sJpO9KMY). */
  live?: {
    get(): Promise<LiveSettings>;
    set(
      change: Partial<LiveSettings>,
    ): Promise<{ ok: boolean; settings?: LiveSettings; message?: string }>;
    onChanged(listener: (settings: LiveSettings) => void): () => void;
  };
  /** Each stream's containers' order and hidden set (REQ-000030-sJpO9KMY). */
  series?: {
    get(stream: string): Promise<{ order: string[]; hidden: string[] }>;
    set(arrangement: { stream: string; order: string[]; hidden: string[] }): Promise<{
      ok: boolean;
    }>;
  };
  /** The log panels' choices and Export .log (REQ-000029-sJpO9KMY). */
  logs?: {
    prefs(): Promise<{ order: "newest" | "oldest"; lanesOpen: boolean; hostOpen?: boolean }>;
    setPrefs(change: {
      order?: "newest" | "oldest";
      lanesOpen?: boolean;
      hostOpen?: boolean;
    }): Promise<{ ok: boolean }>;
    exportLog(request: {
      source: string;
      name: string;
      from: string;
      to: string;
      order: "newest" | "oldest";
      file?: boolean;
    }): Promise<
      { ok: true; path: string; rows: number } | { ok: false; cancelled?: true; message?: string }
    >;
  };
  /** The data-stream picker's last stream per Sump (REQ-000026-sJpO9KMY). */
  picker?: {
    lastStream(sump: string): Promise<string | null>;
    setLastStream(choice: { sump: string; stream: string }): Promise<{ ok: boolean }>;
  };
  sump: {
    active(): Promise<{ id: string; name: string; kind: string } | null>;
    states(): Promise<StateRecord[]>;
    onState(listener: (record: StateRecord) => void): () => void;
    list(): Promise<ListedSump[]>;
    switchTo(target: { id: string; confirmed?: boolean }): Promise<SwitchResult>;
    request: SumpRequester;
  };
  status: {
    history(): Promise<Notice[]>;
    add(text: string): Promise<{ ok: boolean; message?: string }>;
    clear(): Promise<{ ok: boolean }>;
    visible(): Promise<boolean>;
    setVisible(visible: boolean): Promise<{ ok: boolean }>;
    onNotice(listener: (event: NoticeEvent) => void): () => void;
    onVisibility(listener: (visible: boolean) => void): () => void;
  };
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
