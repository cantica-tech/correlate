/**
 * The Preferences dialog's pieces (REQ-000050-sJpO9KMY): the own log's row in
 * words, and the appearance store every canvas draws with.
 */
import { describe, expect, it } from "vitest";
import { APPEARANCE_DEFAULTS, appearance, setAppearance } from "../../theme/appearance.js";
import { ownLogText } from "../PreferencesDialog.js";

describe("REQ-000050-sJpO9KMY: the Preferences dialog", () => {
  it("says where the own log writes, or that it is off", () => {
    expect(ownLogText({ enabled: true, dir: "/Users/me/logs", current: null })).toBe(
      "Folder: /Users/me/logs",
    );
    expect(ownLogText({ enabled: false, dir: "/Users/me/logs", current: null })).toBe("Off");
    expect(ownLogText(null)).toBe("");
  });

  it("draws with cttc's defaults until the main process says otherwise", () => {
    expect(appearance()).toEqual(APPEARANCE_DEFAULTS);
    setAppearance({ ...APPEARANCE_DEFAULTS, nowStyle: "solid" });
    expect(appearance().nowStyle).toBe("solid");
    setAppearance(APPEARANCE_DEFAULTS);
  });
});
