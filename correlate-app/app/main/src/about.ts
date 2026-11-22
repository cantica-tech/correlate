/**
 * About (REQ-000051-sJpO9KMY, cttc's `showAboutDialog`): the app's real
 * version, build and stack, and the window's Sump's, in the system's own
 * message box with OK and Copy (decided in FEAT-000053-sJpO9KMY).
 *
 * The build: `build-info.json` beside the app, written by the packaging build
 * (`build/stamp.js`): its version, commit and date. A build from source has
 * none: it says "development build" with the checkout's commit when `git`
 * answers.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/** Where this build comes from. */
export interface BuildInfo {
  version: string;
  commit: string | null;
  /** When the packaging build ran (ISO), or null from source. */
  builtAt: string | null;
  development: boolean;
}

/** The window's Sump, as About shows it. */
export type SumpAbout =
  | {
      name: string;
      version: string | null;
      plugins: { name: string; version: string | null; state: string }[];
    }
  | { name: string; error: string }
  | null;

/** The stamp's file name, beside the app. */
export const BUILD_INFO = "build-info.json";

/** The build: the stamp if there is one, else a development build. */
export function readBuildInfo(
  appDir: string,
  version: string,
  read: (file: string) => string = (f) => readFileSync(f, "utf8"),
  commitOf: (dir: string) => string | null = gitCommit,
): BuildInfo {
  try {
    const stamp = JSON.parse(read(path.join(appDir, BUILD_INFO))) as Partial<BuildInfo>;
    if (typeof stamp.version === "string") {
      return {
        version: stamp.version,
        commit: typeof stamp.commit === "string" ? stamp.commit : null,
        builtAt: typeof stamp.builtAt === "string" ? stamp.builtAt : null,
        development: false,
      };
    }
  } catch {
    // No stamp: a build from source.
  }
  return { version, commit: commitOf(appDir), builtAt: null, development: true };
}

/** The checkout's short commit, or null when `git` does not answer. */
export function gitCommit(dir: string): string | null {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 3000,
    });
    const out = r.status === 0 ? String(r.stdout).trim() : "";
    return /^[0-9a-f]{4,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/** The Sump's part from its `/health` and `/plugins` answers. */
export function sumpAbout(name: string, health: unknown, plugins: unknown): SumpAbout {
  const version = (health as { version?: unknown } | null)?.version;
  const list = (plugins as { plugins?: unknown } | null)?.plugins;
  return {
    name,
    version: typeof version === "string" ? version : null,
    plugins: Array.isArray(list)
      ? list.map((p) => {
          const entry = p as {
            name?: unknown;
            state?: unknown;
            info?: { version?: unknown } | null;
          };
          return {
            name: String(entry.name ?? "?"),
            version: typeof entry.info?.version === "string" ? entry.info.version : null,
            state: String(entry.state ?? "?"),
          };
        })
      : [],
  };
}

/** The versions of what the app runs on. */
export interface Stack {
  electron: string;
  chrome: string;
  node: string;
}

/** About's text, as the message box shows it and Copy copies it. */
export function aboutText(build: BuildInfo, stack: Stack, sump: SumpAbout, year: number): string {
  const lines = [`Version ${build.version}`];
  if (build.development) {
    lines.push(`Development build${build.commit ? ` • ${build.commit}` : ""}`);
  } else if (build.builtAt || build.commit) {
    const date = build.builtAt ? `Built ${build.builtAt.slice(0, 10)}` : "Built";
    lines.push(`${date}${build.commit ? ` • ${build.commit.slice(0, 7)}` : ""}`);
  }
  lines.push(`© ${year} Olivier Steck`, "", "Built with:");
  lines.push(
    `  • Electron ${stack.electron}`,
    `  • Chromium ${stack.chrome}`,
    `  • Node.js ${stack.node}`,
  );
  lines.push("", "Sump:");
  if (sump === null) lines.push("  not connected");
  else if ("error" in sump) lines.push(`  ${sump.name}: not reachable (${sump.error})`);
  else {
    lines.push(`  ${sump.name}${sump.version ? ` ${sump.version}` : ""}`);
    for (const p of sump.plugins)
      lines.push(
        `  • ${p.name}${p.version ? ` ${p.version}` : ""}${p.state === "loaded" ? "" : ` (${p.state})`}`,
      );
  }
  return lines.join("\n");
}
