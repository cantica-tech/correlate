/**
 * The instance catalog (br-SUMP-000001-sJpO9KMY, REQ-000012-sJpO9KMY
 * Requirements 1 and 2): every Sump the app has connected to, one JSON
 * document per Sump in SQLite (`node:sqlite`) at `~/.correlate/catalog.db`,
 * owner-only (decided in FEAT-000013-sJpO9KMY).
 *
 * A Sump is recorded only after a successful connect, deduplicated by id,
 * else by where it is: the local Sump is the one entry with id `local`; a
 * remote one is its SSH target, SSH port and Sump port. Deleting is soft
 * (`retiredAt`), so history stays; retired Sumps are left out of `list()`.
 *
 * A file that is not a database, fails SQLite's integrity check or holds a
 * document that does not validate is refused with `CatalogError("corrupt")`
 * and left untouched. cttc read a corrupt `gateways.json` as empty and saved
 * over it, losing every gateway (cttc BUG-000003-uKKrzikI).
 */
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensurePrivateDir, restrictToOwner } from "../vault/secure.js";

/** Where the catalog lives unless told otherwise. */
export function defaultCatalogPath(): string {
  return path.join(homedir(), ".correlate", "catalog.db");
}

/** The id of the one local Sump. */
export const LOCAL_ID = "local";

/** The catalog's schema version. */
const SCHEMA_VERSION = "1";

/** One Sump in the catalog. */
export interface SumpEntry {
  id: string;
  name: string;
  kind: "local" | "remote";
  /** The Sump's HTTP port on its host (8765 by default). */
  sumpPort: number;
  /** Remote Sumps: `user@host` or `host`, and the SSH port. */
  sshTarget?: string;
  sshPort?: number;
  /** The user name last logged in as. */
  user?: string;
  addedAt: string;
  lastConnectedAt: string;
  /** Set when retired; the entry stays as history. */
  retiredAt?: string;
}

/** What a successful connect tells the catalog. */
export interface ConnectInput {
  id?: string;
  name?: string;
  kind: "local" | "remote";
  sumpPort: number;
  sshTarget?: string;
  sshPort?: number;
  user?: string;
}

/** Why the catalog refused. */
export type CatalogErrorCode = "corrupt" | "invalid" | "not-found";

/** A catalog refusal; "corrupt" means the file is left exactly as it was. */
export class CatalogError extends Error {
  override readonly name = "CatalogError";

  constructor(
    readonly code: CatalogErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function port(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535;
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 256;
}

/** Why `doc` is not a valid entry, or `undefined` when it is. */
export function entryProblem(doc: unknown): string | undefined {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "not an object";
  const e = doc as Record<string, unknown>;
  const known = new Set([
    "id",
    "name",
    "kind",
    "sumpPort",
    "sshTarget",
    "sshPort",
    "user",
    "addedAt",
    "lastConnectedAt",
    "retiredAt",
  ]);
  const extra = Object.keys(e).find((k) => !known.has(k));
  if (extra) return `unknown field ${extra}`;
  if (!text(e.id)) return "id missing";
  if (!text(e.name)) return "name missing";
  if (e.kind !== "local" && e.kind !== "remote") return "kind must be local or remote";
  if (!port(e.sumpPort)) return "sumpPort must be 1-65535";
  if (e.kind === "local" && e.id !== LOCAL_ID) return `the local Sump's id must be ${LOCAL_ID}`;
  if (e.kind === "remote") {
    if (!text(e.sshTarget)) return "a remote Sump needs sshTarget";
    if (e.sshPort !== undefined && !port(e.sshPort)) return "sshPort must be 1-65535";
  } else if (e.sshTarget !== undefined || e.sshPort !== undefined) {
    return "a local Sump has no SSH target";
  }
  if (e.user !== undefined && !text(e.user)) return "user must be text";
  for (const field of ["addedAt", "lastConnectedAt"]) {
    if (typeof e[field] !== "string" || !ISO.test(e[field] as string)) return `${field} missing`;
  }
  if (e.retiredAt !== undefined && (typeof e.retiredAt !== "string" || !ISO.test(e.retiredAt))) {
    return "retiredAt must be a time";
  }
  return undefined;
}

/** Where a remote Sump is, for deduplication. */
function place(e: { sshTarget?: string; sshPort?: number; sumpPort: number }): string {
  return `${(e.sshTarget ?? "").toLowerCase()}|${e.sshPort ?? 22}|${e.sumpPort}`;
}

export class Catalog {
  private constructor(
    private readonly db: DatabaseSync,
    readonly file: string,
  ) {}

  /**
   * Open (or create) the catalog at `file`. A corrupt file is refused and
   * left as it is.
   */
  static open(file: string = defaultCatalogPath()): Catalog {
    const fresh = !existsSync(file);
    ensurePrivateDir(path.dirname(file));
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file);
    } catch (error) {
      throw corrupt(file, error);
    }
    try {
      const check = db.prepare("PRAGMA quick_check").all() as { quick_check: string }[];
      if (check.length !== 1 || check[0]?.quick_check !== "ok") {
        throw new Error(check.map((row) => row.quick_check).join("; "));
      }
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string;
      }[];
      const names = new Set(tables.map((t) => t.name));
      if (!fresh && names.size > 0 && !(names.has("meta") && names.has("sumps"))) {
        throw new Error(`unexpected tables: ${[...names].join(", ")}`);
      }
    } catch (error) {
      db.close();
      throw corrupt(file, error);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS sumps (id TEXT PRIMARY KEY, document TEXT NOT NULL) STRICT;
    `);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as
      | { value: string }
      | undefined;
    if (version === undefined) {
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema', ?)").run(SCHEMA_VERSION);
    } else if (version.value !== SCHEMA_VERSION) {
      db.close();
      throw new CatalogError(
        "corrupt",
        `The catalog ${file} has schema ${version.value}; this app reads ${SCHEMA_VERSION}. It is left as is.`,
      );
    }
    if (fresh) restrictToOwner(file, "file");
    const catalog = new Catalog(db, file);
    try {
      catalog.list({ retired: true }); // Every document must read back, or it is refused.
    } catch (error) {
      db.close();
      throw error;
    }
    return catalog;
  }

  /** The Sumps in the catalog; retired ones only when asked. */
  list(options: { retired?: boolean } = {}): SumpEntry[] {
    const rows = this.db.prepare("SELECT id, document FROM sumps ORDER BY id").all() as {
      id: string;
      document: string;
    }[];
    const entries = rows.map((row) => this.parse(row.id, row.document));
    return options.retired ? entries : entries.filter((e) => e.retiredAt === undefined);
  }

  /** One Sump, retired or not, or `undefined`. */
  get(id: string): SumpEntry | undefined {
    const row = this.db.prepare("SELECT document FROM sumps WHERE id = ?").get(id) as
      | { document: string }
      | undefined;
    return row ? this.parse(id, row.document) : undefined;
  }

  /**
   * Record a successful connect: update the Sump it matches (by id, else by
   * where it is), or add it. Reconnecting to a retired Sump by id brings it
   * back.
   */
  recordConnect(input: ConnectInput, now: Date = new Date()): SumpEntry {
    const at = now.toISOString();
    return this.transaction(() => {
      let existing: SumpEntry | undefined;
      if (input.id !== undefined) existing = this.get(input.id);
      else if (input.kind === "local") existing = this.get(LOCAL_ID);
      else existing = this.list().find((e) => e.kind === "remote" && place(e) === place(input));
      const id = existing?.id ?? input.id ?? (input.kind === "local" ? LOCAL_ID : randomUUID());
      const entry: SumpEntry = {
        id,
        name:
          input.name ??
          existing?.name ??
          (input.kind === "local" ? "This machine" : (input.sshTarget as string)),
        kind: input.kind,
        sumpPort: input.sumpPort,
        addedAt: existing?.addedAt ?? at,
        lastConnectedAt: at,
      };
      if (input.kind === "remote") {
        entry.sshTarget = input.sshTarget;
        if (input.sshPort !== undefined) entry.sshPort = input.sshPort;
      }
      const user = input.user ?? existing?.user;
      if (user !== undefined) entry.user = user;
      this.write(entry);
      return entry;
    });
  }

  /** Retire a Sump: hidden from pickers, kept as history. */
  retire(id: string, now: Date = new Date()): SumpEntry {
    return this.transaction(() => {
      const entry = this.get(id);
      if (!entry) throw new CatalogError("not-found", `No Sump ${id} in the catalog.`);
      if (entry.retiredAt === undefined) entry.retiredAt = now.toISOString();
      this.write(entry);
      return entry;
    });
  }

  /** The Sump the last window was on, if it is still in the catalog and not retired. */
  lastActive(): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'last_active'").get() as
      | { value: string }
      | undefined;
    const entry = row ? this.get(row.value) : undefined;
    return entry && entry.retiredAt === undefined ? entry.id : undefined;
  }

  /** Remember the Sump a window made active, for the next window. */
  setLastActive(id: string): void {
    this.db
      .prepare(
        "INSERT INTO meta (key, value) VALUES ('last_active', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(id);
  }

  close(): void {
    this.db.close();
  }

  private write(entry: SumpEntry): void {
    const problem = entryProblem(entry);
    if (problem) throw new CatalogError("invalid", `Sump ${entry.id}: ${problem}.`);
    this.db
      .prepare(
        "INSERT INTO sumps (id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document",
      )
      .run(entry.id, JSON.stringify(entry));
  }

  private parse(id: string, document: string): SumpEntry {
    let doc: unknown;
    try {
      doc = JSON.parse(document);
    } catch {
      throw new CatalogError(
        "corrupt",
        `The catalog ${this.file}: Sump ${id} is not JSON; it is left as is.`,
      );
    }
    const problem = entryProblem(doc) ?? ((doc as SumpEntry).id !== id ? "id mismatch" : undefined);
    if (problem) {
      throw new CatalogError(
        "corrupt",
        `The catalog ${this.file}: Sump ${id}: ${problem}; it is left as is.`,
      );
    }
    return doc as SumpEntry;
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function corrupt(file: string, error: unknown): CatalogError {
  const why = error instanceof Error ? error.message : String(error);
  return new CatalogError(
    "corrupt",
    `The catalog ${file} cannot be read (${why}); it is left as is.`,
  );
}
