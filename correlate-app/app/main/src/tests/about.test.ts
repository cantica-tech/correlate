import { describe, expect, it } from "vitest";
import { aboutText, gitCommit, readBuildInfo, sumpAbout } from "../about.js";
import { nativeMenuTemplate } from "../menu.js";

// REQ-000051-sJpO9KMY: About's real version, build and stack, and the Sump's.

const stack = { electron: "44.3.0", chrome: "140.0.0", node: "24.1.0" };

describe("REQ-000051-sJpO9KMY: the build", () => {
  it("is the packaging build's stamp when there is one", () => {
    const build = readBuildInfo(
      "/app",
      "0.1.0",
      () =>
        JSON.stringify({
          version: "0.2.0",
          commit: "abcdef1234567",
          builtAt: "2026-11-22T21:00:00Z",
        }),
      () => "ignored",
    );
    expect(build).toEqual({
      version: "0.2.0",
      commit: "abcdef1234567",
      builtAt: "2026-11-22T21:00:00Z",
      development: false,
    });
  });

  it("is a development build with the checkout's commit otherwise", () => {
    const build = readBuildInfo(
      "/app",
      "0.1.0",
      () => {
        throw new Error("ENOENT");
      },
      () => "5a0cdba",
    );
    expect(build).toEqual({
      version: "0.1.0",
      commit: "5a0cdba",
      builtAt: null,
      development: true,
    });
    expect(gitCommit("/nowhere-at-all")).toBeNull();
  });
});

describe("REQ-000051-sJpO9KMY: About's text", () => {
  it("says the version, the build, the stack and the Sump with its plugins", () => {
    const sump = sumpAbout(
      "lab",
      { status: "ok", version: "0.1.0", redis: true },
      {
        plugins: [
          { name: "events", state: "loaded", info: { name: "events", version: "0.1.0" } },
          { name: "ssh", state: "failed", info: null },
        ],
      },
    );
    const text = aboutText(
      {
        version: "0.2.0",
        commit: "abcdef1234567",
        builtAt: "2026-11-22T21:00:00Z",
        development: false,
      },
      stack,
      sump,
      2026,
    );
    expect(text.split("\n")).toEqual([
      "Version 0.2.0",
      "Built 2026-11-22 • abcdef1",
      "© 2026 Olivier Steck",
      "",
      "Built with:",
      "  • Electron 44.3.0",
      "  • Chromium 140.0.0",
      "  • Node.js 24.1.0",
      "",
      "Sump:",
      "  lab 0.1.0",
      "  • events 0.1.0",
      "  • ssh (failed)",
    ]);
  });

  it("says a development build, and a Sump not connected or not reachable", () => {
    const dev = { version: "0.1.0", commit: "5a0cdba", builtAt: null, development: true };
    expect(aboutText(dev, stack, null, 2026)).toContain("Development build • 5a0cdba");
    expect(aboutText(dev, stack, null, 2026)).toMatch(/Sump:\n {2}not connected$/);
    expect(aboutText(dev, stack, { name: "lab", error: "timed out" }, 2026)).toMatch(
      /lab: not reachable \(timed out\)$/,
    );
  });

  it("is the macOS app menu's About, in place of Electron's panel", () => {
    let shown = 0;
    const menu = nativeMenuTemplate("darwin", "correlate-app", () => {
      shown++;
    });
    const about = menu?.[0]?.submenu?.[0];
    expect(about?.label).toBe("About correlate-app");
    about?.click?.();
    expect(shown).toBe(1);
    expect(nativeMenuTemplate("darwin", "x")?.[0]?.submenu?.[0]).toEqual({ role: "about" });
  });
});
