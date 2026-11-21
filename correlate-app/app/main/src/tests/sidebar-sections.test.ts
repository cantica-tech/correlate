import { describe, expect, it } from "vitest";
import { SECTIONS, SEPARATOR } from "../../../renderer/src/shell/sections.js";
import { SECTIONS as SECTION_IDS, SIDEBAR_ACTIONS } from "../sidebar.js";

// REQ-000021-sJpO9KMY: the main process knows exactly the sidebar's actions
// and sections, so the detached window can ask for any entry and nothing else.

describe("REQ-000021-sJpO9KMY: the sidebar's actions", () => {
  it("are the renderer's entries, and Preferences, About and Quit", () => {
    const entries = SECTIONS.flatMap((s) =>
      s.entries.filter((e) => e !== SEPARATOR).map((e) => e.action),
    );
    expect([...entries, "preferences", "about", "quit"]).toEqual([...SIDEBAR_ACTIONS]);
    expect(SECTIONS.map((s) => s.id)).toEqual([...SECTION_IDS]);
  });
});
