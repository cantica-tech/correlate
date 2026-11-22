/**
 * Stamp the build for About (REQ-000051-sJpO9KMY): `build-info.json` beside
 * the app, its version (package.json's, or the first argument), the commit
 * and the date. Run by the packaging build only; a build from source has no
 * stamp and About says "development build".
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(app, "package.json"), "utf8"));
let commit = null;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: app, encoding: "utf8" }).trim();
} catch {
  // Not a checkout: the stamp says no commit.
}
const info = { version: process.argv[2] || pkg.version, commit, builtAt: new Date().toISOString() };
writeFileSync(path.join(app, "build-info.json"), `${JSON.stringify(info, null, 2)}\n`);
console.log(`stamped ${info.version} ${commit ? commit.slice(0, 7) : "(no commit)"}`);
