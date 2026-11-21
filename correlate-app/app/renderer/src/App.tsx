/**
 * The app's root component: the shell, cttc's sidebar beside the main
 * content (REQ-000021-sJpO9KMY). The status bar and the menus come with
 * Items 23 and 24 of `docs/roadmap/correlate-app-rewrite.md`.
 */
import { Shell } from "./shell/Shell.js";

/** The root: the shell, or the detached sidebar alone. */
export function App({ detached = false }: { detached?: boolean }) {
  const bridge = window.correlate;
  if (!bridge) return <main />;
  return <Shell bridge={bridge} detached={detached} />;
}
