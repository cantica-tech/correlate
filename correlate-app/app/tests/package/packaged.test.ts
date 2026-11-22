/**
 * The packaged app (br-BUILD-000010-sJpO9KMY, REQ-000054-sJpO9KMY): once
 * `task app:package` has built this system's installer, the app it holds
 * starts, opens its window from the archive, says its own version (the
 * Sump image it provisions is tagged with it, `sumpImage`), and carries its
 * build stamp. Skipped when nothing was packaged here.
 *
 * It runs with a throwaway home folder, so the user's own catalog, vault and
 * settings are never read or written.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";
import { describe, expect, it } from "vitest";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = (
  JSON.parse(readFileSync(path.join(APP, "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** This system's packaged executable, as electron-builder lays it out. */
function packaged(): string | undefined {
  const name = "correlate-app";
  const candidates =
    process.platform === "darwin"
      ? [`mac-${process.arch}`, "mac"].map((d) =>
          path.join(APP, "dist", d, `${name}.app`, "Contents", "MacOS", name),
        )
      : process.platform === "win32"
        ? [path.join(APP, "dist", "win-unpacked", `${name}.exe`)]
        : [path.join(APP, "dist", "linux-unpacked", name)];
  return candidates.find((c) => existsSync(c));
}

const executable = packaged();

describe.skipIf(!executable)("br-BUILD-000010-sJpO9KMY: the packaged app", () => {
  it("starts from its archive, says its version and carries its build stamp", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "correlate-packaged-"));
    const env = { ...process.env, HOME: home, USERPROFILE: home } as Record<string, string>;
    delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: executable as string, env });
    try {
      const window = await app.firstWindow();
      await window.waitForLoadState("domcontentloaded");
      expect(window.url()).toMatch(/app\.asar\/renderer\/index\.html/);
      const facts = await app.evaluate(({ app: electronApp }) => ({
        version: electronApp.getVersion(),
        packaged: electronApp.isPackaged,
        name: electronApp.getName(),
      }));
      expect(facts).toEqual({ version: VERSION, packaged: true, name: "correlate-app" });
      // The stamp About shows (REQ-000051-sJpO9KMY), packaged beside main.cjs.
      const stamp = await app.evaluate(({ app: electronApp }) => {
        const fs = process.getBuiltinModule("node:fs") as typeof import("node:fs");
        return fs.readFileSync(`${electronApp.getAppPath()}/build-info.json`, "utf8");
      });
      expect(JSON.parse(stamp as string).version).toBe(VERSION);
    } finally {
      await app.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});
