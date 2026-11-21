import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Catalog, CatalogError, entryProblem, LOCAL_ID } from "../catalog.js";

// br-SUMP-000001-sJpO9KMY (REQ-000012-sJpO9KMY Requirements 1 and 2): the
// catalog is a deduplicated, soft-delete history that is never overwritten.

const POSIX = process.platform !== "win32";
const T1 = new Date("2026-11-21T10:00:00Z");
const T2 = new Date("2026-11-21T11:00:00Z");
let dir: string;
let file: string;
const open: Catalog[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "catalog-test-"));
  file = path.join(dir, ".correlate", "catalog.db");
});
afterEach(() => {
  for (const c of open.splice(0)) c.close();
  rmSync(dir, { recursive: true, force: true });
});

function catalog(): Catalog {
  const c = Catalog.open(file);
  open.push(c);
  return c;
}

const remote = { kind: "remote" as const, sumpPort: 8765, sshTarget: "ops@box", sshPort: 22 };

describe("br-SUMP-000001-sJpO9KMY: the catalog", () => {
  it("records the local Sump once, and updates it on reconnect", () => {
    const c = catalog();
    const first = c.recordConnect({ kind: "local", sumpPort: 8765, user: "olivier" }, T1);
    const again = c.recordConnect({ kind: "local", sumpPort: 8765 }, T2);
    expect(first.id).toBe(LOCAL_ID);
    expect(again).toMatchObject({
      id: LOCAL_ID,
      name: "This machine",
      user: "olivier",
      addedAt: T1.toISOString(),
      lastConnectedAt: T2.toISOString(),
    });
    expect(c.list()).toHaveLength(1);
  });

  it("deduplicates remote Sumps by id, else by where they are", () => {
    const c = catalog();
    const a = c.recordConnect(remote, T1);
    expect(c.recordConnect({ ...remote, sshTarget: "OPS@box" }, T2).id).toBe(a.id);
    const other = c.recordConnect({ ...remote, sumpPort: 9000 }, T2);
    expect(other.id).not.toBe(a.id);
    expect(c.recordConnect({ ...remote, id: a.id, sumpPort: 9100 }, T2).id).toBe(a.id);
    expect(
      c
        .list()
        .map((e) => e.id)
        .sort(),
    ).toEqual([a.id, other.id].sort());
  });

  it("retires softly: hidden from list(), kept as history", () => {
    const c = catalog();
    const a = c.recordConnect(remote, T1);
    c.retire(a.id, T2);
    expect(c.list()).toEqual([]);
    expect(c.list({ retired: true })).toEqual([{ ...a, retiredAt: T2.toISOString() }]);
    // The same place again is a new entry; the retired one stays.
    const b = c.recordConnect(remote, T2);
    expect(b.id).not.toBe(a.id);
    expect(c.list({ retired: true })).toHaveLength(2);
    expect(() => c.retire("nope")).toThrow(expect.objectContaining({ code: "not-found" }));
  });

  it("keeps everything across reopening", () => {
    const c = catalog();
    const a = c.recordConnect(remote, T1);
    c.setLastActive(a.id);
    c.close();
    open.pop();
    const again = catalog();
    expect(again.get(a.id)).toEqual(a);
    expect(again.lastActive()).toBe(a.id);
    again.retire(a.id);
    expect(again.lastActive()).toBeUndefined();
  });

  it("is owner-only on disk", () => {
    catalog().recordConnect(remote, T1);
    if (POSIX) {
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o077).toBe(0);
    }
  });

  it.each([
    [{}, "id missing"],
    [{ id: "x", name: "x", kind: "cloud", sumpPort: 1 }, "kind"],
    [{ id: "local", name: "x", kind: "local", sumpPort: 70000 }, "sumpPort"],
    [{ id: "x", name: "x", kind: "remote", sumpPort: 1 }, "sshTarget"],
    [{ id: "x", name: "x", kind: "local", sumpPort: 1 }, "local Sump's id"],
  ])("refuses an invalid document %j", (doc, why) => {
    expect(entryProblem(doc)).toContain(why);
  });
});

describe("br-SUMP-000001-sJpO9KMY: a corrupt catalog is refused and left alone", () => {
  function refusedUntouched() {
    const before = readFileSync(file);
    expect(() => Catalog.open(file)).toThrow(CatalogError);
    try {
      Catalog.open(file);
    } catch (error) {
      expect((error as CatalogError).code).toBe("corrupt");
      expect((error as Error).message).toContain("left as is");
    }
    expect(readFileSync(file).equals(before)).toBe(true);
  }

  it("refuses a file that is not a database", () => {
    catalog();
    writeFileSync(file, "this is not SQLite, it is gateways.json: {");
    refusedUntouched();
  });

  it("refuses a truncated database", () => {
    const c = catalog();
    for (let i = 0; i < 50; i += 1) c.recordConnect({ ...remote, sumpPort: 1000 + i }, T1);
    c.close();
    open.pop();
    const bytes = readFileSync(file);
    writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2) + 7));
    refusedUntouched();
  });

  it("refuses a document that does not validate", () => {
    const c = catalog();
    c.recordConnect(remote, T1);
    c.close();
    open.pop();
    const db = new DatabaseSync(file);
    db.prepare("UPDATE sumps SET document = ?").run('{"id": "broken"}');
    db.close();
    refusedUntouched();
  });

  it("refuses a database of something else", () => {
    catalog();
    open.pop()?.close();
    const db = new DatabaseSync(file);
    db.exec("DROP TABLE sumps; CREATE TABLE other (x)");
    db.close();
    refusedUntouched();
  });
});

describe("br-SUMP-000002-sJpO9KMY: an uninstalled local Sump is kept as history", () => {
  it("archives the retired local Sump so a new one can start", () => {
    const c = catalog();
    c.recordConnect({ kind: "local", sumpPort: 8765, user: "olivier" }, T1);
    expect(c.archiveRetiredLocal(T2)).toBeUndefined();
    c.retire(LOCAL_ID, T1);
    const archive = c.archiveRetiredLocal(T2);
    expect(archive).toBe(`local-retired-${T2.getTime()}`);
    expect(c.get(LOCAL_ID)).toBeUndefined();
    expect(c.get(archive as string)).toMatchObject({ kind: "local", user: "olivier" });
    expect(c.recordConnect({ kind: "local", sumpPort: 8765 }, T2).addedAt).toBe(T2.toISOString());
    expect(c.list({ retired: true })).toHaveLength(2);
  });

  it("keeps a remote Sump's host key and SSH key id", () => {
    const c = catalog();
    const a = c.recordConnect({ ...remote, hostKey: "SHA256:abc", sshKeyId: "identity" }, T1);
    expect(c.recordConnect(remote, T2)).toMatchObject({ id: a.id, hostKey: "SHA256:abc" });
    expect(c.amend(a.id, { sshKeyId: "ssh:x" }).sshKeyId).toBe("ssh:x");
    expect(entryProblem({ ...a, hostKey: "MD5:aa" })).toContain("hostKey");
  });
});
