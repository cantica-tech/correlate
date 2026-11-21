/**
 * What the Sump pill shows (REQ-000022-sJpO9KMY Requirement 3), from the
 * lifecycle the main process keeps (br-SUMP-000011-sJpO9KMY): cttc's
 * `data-state` values.
 */
import type { ListedSump, StateRecord } from "../shell/bridge.js";

/** cttc's pill states: a green, red or yellow dot. */
export type PillState = "up" | "down" | "checking";

/** The pill's state for the window's Sump. */
export function pillState(
  activeId: string | undefined,
  states: ReadonlyMap<string, StateRecord>,
): PillState {
  const state = activeId ? states.get(activeId)?.state : undefined;
  if (state === "active") return "up";
  if (state === "unreachable" || state === "retired") return "down";
  return "checking";
}

/** What the dot says, for screen readers and its tooltip. */
export const PILL_WORDS: Record<PillState, string> = {
  up: "answering",
  down: "not answering",
  checking: "being checked",
};

/** Where a Sump is, as the switcher's second line: cttc's `host:port`. */
export function whereIs(sump: ListedSump): string {
  if (sump.kind === "local") return `localhost:${sump.sumpPort}`;
  const target = sump.sshTarget ?? "?";
  return sump.sshPort && sump.sshPort !== 22 ? `${target}:${sump.sshPort}` : target;
}

/** Current Status's rows: label and value, `null` for a separator. */
export function statusRows(sump: ListedSump): ([string, string] | null)[] {
  if (sump.kind === "local") {
    return [
      ["Connection", "local"],
      ["Sump", sump.name],
      ["Address", `localhost:${sump.sumpPort}`],
    ];
  }
  const forwarded = sump.forwardUrl ? new URL(sump.forwardUrl).port : undefined;
  return [
    ["Connection", "SSH forward"],
    ["Sump", sump.name],
    null,
    ["ssh target", sump.sshTarget ?? "?"],
    ["ssh port", String(sump.sshPort ?? 22)],
    ["Sump port", String(sump.sumpPort)],
    ["forwarded port", forwarded ? `localhost:${forwarded}` : "not up"],
  ];
}
