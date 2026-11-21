/**
 * Regression corpus of cttc's bugs: recording (REC).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Catalog } from "../../../main/src/catalog/catalog.js";
import { Lifecycle } from "../../../main/src/catalog/lifecycle.js";
import { ActiveSumps } from "../../../main/src/catalog/windows.js";
import { provisionLocal } from "../../../main/src/provision/local.js";
import { switchSump } from "../../../main/src/provision/manage.js";
import { SessionTokens } from "../../../main/src/sump/tokens.js";

describe("br-REC-000001-sJpO9KMY", () => {
  // BUG-000029-uKKrzikI, High (roadmap Item 16, RM-000017-sJpO9KMY; the
  // recordings themselves with Item 40): cttc's New Gateway and pill switch
  // moved the window to another gateway with no recording check. Every path
  // that switches now asks first while a recording is live, and moves nothing
  // until confirmed. Item 40 plugs the real recordings into the same guard.
  it("cttc BUG-000029: New Gateway and pill switch change the active gateway with no recording check", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "cttc-recording-"));
    try {
      const catalog = Catalog.open(path.join(dir, "catalog.db"));
      const other = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "other" });
      const active = new ActiveSumps(catalog);
      active.open(1);
      const commands: string[][] = [];
      const ctx = {
        run: async (command: string, args: string[]) => {
          commands.push([command, ...args]);
          return { code: 0, stdout: "29\n", stderr: "", timedOut: false };
        },
        lifecycle: new Lifecycle(catalog, undefined, { info: () => {} }),
        tokens: new SessionTokens(),
        vault: undefined,
        env: {},
        appVersion: "0.1.0",
        catalog,
        active,
        pending: new Map(),
        guard: { liveRecording: () => "night run" },
        resolve: () => ({ name: other.id, baseUrl: "http://127.0.0.1:1" }),
        logger: { info: () => {}, warn: () => {} },
      };
      const pill = await switchSump(ctx, 1, other.id);
      const newSump = await provisionLocal(ctx, { windowId: 1, switchTo: true });
      for (const result of [pill, newSump]) {
        expect(result).toMatchObject({ ok: false, step: "confirm" });
      }
      expect(active.get(1)).toBe("local");
      expect(commands).toEqual([]);
      catalog.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
