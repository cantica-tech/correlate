/**
 * The window's project in the sidebar's Projects section (REQ-000035-sJpO9KMY
 * Requirement 3, decided in FEAT-000036-sJpO9KMY): its name (with `•` when
 * unsaved), then its virtual folders and files as a tree in cttc's sidebar
 * rows. A click on a file shows it in the analysis view, the shown one
 * marked; a missing file is greyed and says so. Right-click: on the project,
 * Add Files…, New Folder…, Save, Save As…, Recent, Rename…, Bind to This Sump
 * or Unbind; on a folder, New Folder…, Rename…, Move to, Remove; on a file,
 * Move to, Remove (the file left on disk). A new concept: cttc had no such
 * tree; it is drawn in cttc's rows and context menu.
 */
import { useState } from "react";
import { Button, ContextMenu, Dialog, type MenuEntry } from "../components/index.js";
import { Icon } from "../icons/Icon.js";
import type { OpenList } from "./bridge.js";

/** A folder of the project. */
export interface TreeFolder {
  id: string;
  name: string;
  parent: string | null;
}

/** A file of the project. */
export interface TreeItem {
  id: string;
  path: string;
  folder: string | null;
}

/** What the tree shows of the project. */
export interface TreeProject {
  name: string;
  dirty: boolean;
  isDefault: boolean;
  folders: TreeFolder[];
  items: TreeItem[];
  sump: { id: string; stream: string } | null;
  missing: string[];
}

/** A change, as the main process takes it (`project:change`). */
export type TreeChange =
  | { op: "addFolder"; name: string; parent?: string | null }
  | { op: "rename"; id: string; name: string }
  | { op: "renameProject"; name: string }
  | { op: "move"; id: string; folder: string | null }
  | { op: "remove"; id: string }
  | { op: "unbind" };

/** The tree's props. */
export interface ProjectTreeProps {
  project: TreeProject;
  open: OpenList;
  recent: string[];
  onShow: (id: string) => void;
  onChange: (change: TreeChange) => void;
  onAddFiles: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onOpenRecent: (file: string) => void;
  /** Bind the project to the window's Sump and its active stream. */
  onBind: () => void;
}

/** A file's name from its path, on any platform. */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** Asking for a name: a new folder's, or a rename. */
type Naming = { title: string; value: string; done: (name: string) => void };

/** The tree. */
export function ProjectTree(props: ProjectTreeProps) {
  const { project, open } = props;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; entries: MenuEntry[] } | null>(null);
  const [naming, setNaming] = useState<Naming | null>(null);
  const missing = new Set(project.missing);

  const moveEntries = (id: string, current: string | null): MenuEntry[] => [
    ...(current === null
      ? []
      : [
          {
            label: "Move to the Top",
            onSelect: () => props.onChange({ op: "move", id, folder: null }),
          },
        ]),
    ...project.folders
      .filter((f) => f.id !== id && f.id !== current)
      .map((f) => ({
        label: `Move to ${f.name}`,
        onSelect: () => props.onChange({ op: "move", id, folder: f.id }),
      })),
  ];
  const newFolder = (parent: string | null) =>
    setNaming({
      title: "New Folder",
      value: "",
      done: (name) => props.onChange({ op: "addFolder", name, parent }),
    });

  const projectMenu = (x: number, y: number) =>
    setMenu({
      x,
      y,
      entries: [
        { label: "Add Files…", icon: "load-data", onSelect: props.onAddFiles },
        { label: "New Folder…", icon: "new", onSelect: () => newFolder(null) },
        "separator",
        {
          label: "Save",
          onSelect: props.onSave,
          disabled: project.isDefault,
          title: project.isDefault ? "The default project saves itself" : undefined,
        },
        { label: "Save As…", onSelect: props.onSaveAs },
        ...props.recent.slice(0, 10).map((file) => ({
          label: `Open ${baseName(file)}`,
          title: file,
          onSelect: () => props.onOpenRecent(file),
        })),
        "separator",
        {
          label: "Rename…",
          icon: "edit",
          onSelect: () =>
            setNaming({
              title: "Rename Project",
              value: project.name,
              done: (name) => props.onChange({ op: "renameProject", name }),
            }),
        },
        project.sump
          ? { label: "Unbind from Its Sump", onSelect: () => props.onChange({ op: "unbind" }) }
          : { label: "Bind to This Sump", icon: "sump", onSelect: props.onBind },
      ] as MenuEntry[],
    });

  const files = (folder: string | null, depth: number) =>
    project.items
      .filter((i) => i.folder === folder)
      .map((item) => {
        const gone = missing.has(item.path);
        const shown = open.active === item.path;
        return (
          <button
            type="button"
            key={item.id}
            className="project-row project-file"
            role="treeitem"
            aria-level={depth + 2}
            aria-selected={shown}
            data-depth={depth + 1}
            data-active={shown ? "true" : undefined}
            data-missing={gone ? "true" : undefined}
            title={gone ? `${item.path} (missing)` : item.path}
            onClick={() => props.onShow(item.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                entries: [
                  ...moveEntries(item.id, item.folder),
                  "separator",
                  {
                    label: "Remove from Project",
                    icon: "remove",
                    title: "The file itself is left on disk",
                    onSelect: () => props.onChange({ op: "remove", id: item.id }),
                  },
                ],
              });
            }}
          >
            <span className="project-row-indent" />
            <Icon
              name={item.path.endsWith(".cttc-metric") ? "track" : "recordind"}
              className="ab-icon"
            />
            <span className="project-row-name">{baseName(item.path)}</span>
            {gone ? <span className="project-row-note">missing</span> : null}
          </button>
        );
      });

  const folders = (parent: string | null, depth: number): React.ReactNode[] =>
    project.folders
      .filter((f) => f.parent === parent)
      .flatMap((folder) => {
        const isOpen = !collapsed.has(folder.id);
        return [
          <button
            type="button"
            key={folder.id}
            className="project-row project-folder"
            role="treeitem"
            aria-level={depth + 2}
            aria-expanded={isOpen}
            data-depth={depth + 1}
            onClick={() =>
              setCollapsed((c) => {
                const next = new Set(c);
                if (isOpen) next.add(folder.id);
                else next.delete(folder.id);
                return next;
              })
            }
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({
                x: e.clientX,
                y: e.clientY,
                entries: [
                  { label: "New Folder…", icon: "new", onSelect: () => newFolder(folder.id) },
                  {
                    label: "Rename…",
                    icon: "edit",
                    onSelect: () =>
                      setNaming({
                        title: "Rename Folder",
                        value: folder.name,
                        done: (name) => props.onChange({ op: "rename", id: folder.id, name }),
                      }),
                  },
                  ...moveEntries(folder.id, folder.parent),
                  "separator",
                  {
                    label: "Remove Folder",
                    icon: "remove",
                    title: "Its files and folders move up",
                    onSelect: () => props.onChange({ op: "remove", id: folder.id }),
                  },
                ],
              });
            }}
          >
            <span className="project-row-indent" />
            <span className="project-row-chevron">{isOpen ? "▾" : "▸"}</span>
            <span className="project-row-name">{folder.name}</span>
          </button>,
          ...(isOpen ? [...folders(folder.id, depth + 1), ...files(folder.id, depth + 1)] : []),
        ];
      });

  return (
    <div className="project-tree" role="tree" aria-label={`Project ${project.name}`}>
      <button
        type="button"
        className="project-row project-name"
        role="treeitem"
        aria-level={1}
        data-depth={0}
        title={
          project.isDefault
            ? "The default project; it saves itself"
            : "Right-click for the project's actions"
        }
        onClick={(e) => projectMenu(e.clientX, e.clientY)}
        onContextMenu={(e) => {
          e.preventDefault();
          projectMenu(e.clientX, e.clientY);
        }}
      >
        <Icon name="project" className="ab-icon" />
        <span className="project-row-name">
          {project.name}
          {project.dirty ? " •" : ""}
        </span>
        {project.sump ? <span className="project-row-note">{project.sump.stream}</span> : null}
      </button>
      {folders(null, 0)}
      {files(null, 0)}
      {project.items.length === 0 && project.folders.length === 0 ? (
        <div className="project-empty muted">No files yet: right-click the project to add some</div>
      ) : null}
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          entries={menu.entries}
          label={`Project ${project.name}`}
          onClose={() => setMenu(null)}
        />
      ) : null}
      <NameDialog naming={naming} onClose={() => setNaming(null)} />
    </div>
  );
}

/** Asks for a name, as cttc's small dialogs (a field, Cancel and OK). */
function NameDialog({ naming, onClose }: { naming: Naming | null; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [shownFor, setShownFor] = useState<Naming | null>(null);
  if (naming !== shownFor) {
    setShownFor(naming);
    setValue(naming?.value ?? "");
  }
  const done = () => {
    const name = value.trim();
    if (!naming || !name) return;
    naming.done(name);
    onClose();
  };
  return (
    <Dialog
      id="dlg-project-name"
      open={naming !== null}
      onClose={onClose}
      title={naming?.title ?? ""}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={!value.trim()} onClick={done}>
            OK
          </Button>
        </>
      }
    >
      <label className="ctl block">
        Name
        <input
          type="text"
          value={value}
          maxLength={200}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") done();
          }}
        />
      </label>
    </Dialog>
  );
}
