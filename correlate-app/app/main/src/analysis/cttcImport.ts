/**
 * Importing cttc's files (br-ANLYS-000007 to br-ANLYS-000009-sJpO9KMY,
 * REQ-000055-sJpO9KMY; decision D5): each `.cttc-record` becomes a
 * `.recording`, each `.cttc-metric` a `.track`, beside the original.
 *
 * Both are cttc's archive format version 3, the one correlate-app writes
 * (`../recording/archive.ts`), so a file is converted by copying its entries
 * as they are and writing its manifest again with its integrity hash
 * computed again. The original is read and never written; no file is ever
 * overwritten: a taken name gets " (2)", " (3)". A file cttc's reader refuses
 * is skipped with why; one whose hash did not match is imported and said.
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { manifestHash, readCttcArchive } from "./archive.js";
import { DEFAULT_LIMITS, readZip, type ZipLimits } from "./zip.js";
import { zip } from "./zipWrite.js";

/** cttc's extensions and what each becomes. */
export const IMPORTED_AS: Readonly<Record<string, string>> = {
  ".cttc-record": ".recording",
  ".cttc-metric": ".track",
};

/** One file imported. */
export interface Imported {
  from: string;
  to: string;
  /** What reading it said (a hash that did not match). */
  warnings: string[];
}

/** One file not imported, and why. */
export interface Skipped {
  path: string;
  reason: string;
}

/** What an import did. */
export interface ImportResult {
  imported: Imported[];
  skipped: Skipped[];
}

/** What importing needs; the disk by default. */
export interface ImportDeps {
  read?: (file: string) => Buffer;
  /** Write a new file, refusing an existing one; a never-overwrite write by default. */
  write?: (file: string, bytes: Buffer) => void;
  exists?: (file: string) => boolean;
  isDirectory?: (file: string) => boolean;
  list?: (dir: string) => string[];
  limits?: ZipLimits;
}

/** Whether `file` is one of cttc's files, by its extension. */
export function isCttcFile(file: string): boolean {
  return path.extname(file).toLowerCase() in IMPORTED_AS;
}

/** The file `original` is imported as: beside it, the new extension, a free name. */
export function importedName(original: string, exists: (file: string) => boolean): string {
  const ext = IMPORTED_AS[path.extname(original).toLowerCase()];
  if (!ext) throw new Error(`${path.basename(original)} is not a cttc file`);
  const dir = path.dirname(original);
  const base = path.basename(original, path.extname(original));
  for (let n = 1; ; n++) {
    const candidate = path.join(dir, `${base}${n === 1 ? "" : ` (${n})`}${ext}`);
    if (!exists(candidate)) return candidate;
  }
}

/** A cttc file's bytes in correlate-app's form: its entries, its manifest's hash again. */
export function convert(buf: Buffer, limits: ZipLimits = DEFAULT_LIMITS): Buffer {
  const entries = readZip(buf, limits);
  const raw = entries.get("manifest.json");
  if (!raw) throw new Error("no manifest.json");
  const manifest = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  delete manifest.integrity_sha256;
  const text = JSON.stringify(manifest);
  const out: Record<string, Buffer | string> = {};
  for (const [name, bytes] of entries) if (name !== "manifest.json") out[name] = bytes;
  out["manifest.json"] = JSON.stringify({ ...manifest, integrity_sha256: manifestHash(text) });
  return zip(out);
}

/** The cttc files to import from `chosen`: files, and those directly in folders. */
export function expand(
  chosen: readonly string[],
  deps: ImportDeps,
): {
  files: string[];
  skipped: Skipped[];
} {
  const isDirectory = deps.isDirectory ?? ((p: string) => statSync(p).isDirectory());
  const list = deps.list ?? ((d: string) => readdirSync(d));
  const files: string[] = [];
  const skipped: Skipped[] = [];
  for (const item of chosen) {
    try {
      if (isDirectory(item)) {
        const found = list(item)
          .filter(isCttcFile)
          .sort()
          .map((f) => path.join(item, f))
          .filter((f) => !isDirectory(f));
        if (found.length === 0) skipped.push({ path: item, reason: "no cttc files in it" });
        files.push(...found);
      } else if (isCttcFile(item)) {
        files.push(item);
      } else {
        skipped.push({ path: item, reason: "not a .cttc-record or .cttc-metric" });
      }
    } catch (error) {
      skipped.push({ path: item, reason: (error as Error).message });
    }
  }
  return { files: [...new Set(files)], skipped };
}

/** Import `chosen` (cttc files and folders); never throws, never overwrites. */
export function importCttc(chosen: readonly string[], deps: ImportDeps = {}): ImportResult {
  const read = deps.read ?? ((f: string) => readFileSync(f));
  const write = deps.write ?? ((f: string, b: Buffer) => writeFileSync(f, b, { flag: "wx" }));
  const exists = deps.exists ?? existsSync;
  const limits = deps.limits ?? DEFAULT_LIMITS;
  const { files, skipped } = expand(chosen, deps);
  const imported: Imported[] = [];
  for (const file of files) {
    try {
      const buf = read(file);
      // As cttc's reader reads it: refused here, refused for import.
      const { warnings } = readCttcArchive(buf, file, limits);
      const to = importedName(file, exists);
      write(to, convert(buf, limits));
      imported.push({ from: file, to, warnings });
    } catch (error) {
      skipped.push({ path: file, reason: (error as Error).message });
    }
  }
  return { imported, skipped };
}

/** The summary an import says (br-ANLYS-000009-sJpO9KMY). */
export function importSummary(result: ImportResult): string {
  const parts: string[] = [];
  const n = result.imported.length;
  parts.push(n === 0 ? "No cttc file imported" : `Imported ${n} cttc file${n === 1 ? "" : "s"}`);
  const mismatched = result.imported.filter((i) => i.warnings.length > 0);
  if (mismatched.length > 0) {
    parts.push(
      `${mismatched.map((i) => path.basename(i.from)).join(", ")}: the original's integrity hash did not match`,
    );
  }
  for (const s of result.skipped) parts.push(`${path.basename(s.path)} skipped: ${s.reason}`);
  return parts.join("; ");
}
