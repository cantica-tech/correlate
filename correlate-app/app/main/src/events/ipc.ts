/**
 * The events' channel (REQ-000046-sJpO9KMY Requirement 4): `events:download`
 * (`{ artifact, name, size }`) saves one of the window's Sump's artifacts.
 *
 * Where to save is asked first; then the artifact is fetched from the Sump,
 * which serves only complete ones (409 otherwise), its bytes checked against
 * the size the Sump reported, and only then written, atomically (cttc bug 26:
 * its downloads were never checked). The app then adds it to the project.
 * The events themselves are edited through the window's Sump bridge
 * (`/events`), and firings are followed by `firings.ts`.
 */
import type { IpcEventLike, IpcMainLike } from "../sump/ipc.js";

export const EVENTS_DOWNLOAD_CHANNEL = "events:download";
export const EVENTS_FIRED_EVENT = "events:fired";

/** An artifact id, as the Sump makes them. */
const ARTIFACT = /^[0-9a-f]{16}$/;

/** What a download needs, per calling window. */
export interface DownloadDeps {
  /** The save dialog in the project's folder: the path, or null when cancelled. */
  askSave: (event: IpcEventLike, suggested: string) => Promise<string | null>;
  /** The artifact's bytes from the window's Sump; rejects when it cannot. */
  bytes: (event: IpcEventLike, artifact: string) => Promise<Buffer>;
  /** Write the file atomically. */
  write: (file: string, bytes: Buffer) => Promise<void> | void;
}

/** What a download answers. */
export type DownloadResult =
  | { ok: true; file: string }
  | { ok: false; cancelled?: true; message?: string };

/** A file name from an event's name: letters, digits, `.`, `_` and `-`. */
export function artifactName(event: string, artifact: string): string {
  const safe = event
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${safe || "event"}-${artifact}.recording`;
}

/** Save an artifact: asked first, fetched, checked, written. Never throws. */
export async function downloadArtifact(
  event: IpcEventLike,
  message: unknown,
  deps: DownloadDeps,
): Promise<DownloadResult> {
  const m = (message ?? {}) as Record<string, unknown>;
  const artifact = typeof m.artifact === "string" ? m.artifact : "";
  if (!ARTIFACT.test(artifact)) return { ok: false, message: "not an artifact" };
  const size = typeof m.size === "number" && Number.isFinite(m.size) ? m.size : null;
  const name = typeof m.name === "string" ? m.name : "event";
  const file = await deps.askSave(event, artifactName(name, artifact));
  if (!file) return { ok: false, cancelled: true };
  try {
    const bytes = await deps.bytes(event, artifact);
    if (size !== null && bytes.length !== size) {
      throw new Error(`got ${bytes.length} bytes of the Sump's ${size}: not saved`);
    }
    await deps.write(file, bytes);
    return { ok: true, file };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

/** Answer `events:download`. */
export function registerEventsIpc(ipcMain: IpcMainLike, deps: DownloadDeps): void {
  ipcMain.handle(EVENTS_DOWNLOAD_CHANNEL, (event, message) =>
    downloadArtifact(event, message, deps),
  );
}
