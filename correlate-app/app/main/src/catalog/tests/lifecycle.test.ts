import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { neverAnswers, serve, type TestServer } from "../../sump/tests/servers.js";
import { Catalog } from "../catalog.js";
import {
  Lifecycle,
  STATES,
  type StateRecord,
  type SumpState,
  TRANSITIONS,
  TransitionError,
} from "../lifecycle.js";
import { HealthProbe } from "../probe.js";

// br-SUMP-000011-sJpO9KMY (REQ-000013-sJpO9KMY): one explicit Sump lifecycle.

const quiet = { info: () => {} };
const T0 = new Date("2026-11-21T10:00:00Z");
let dir: string;
let catalog: Catalog;
const servers: TestServer[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "lifecycle-test-"));
  catalog = Catalog.open(path.join(dir, "catalog.db"));
});
afterEach(async () => {
  catalog.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  rmSync(dir, { recursive: true, force: true });
});

/** A lifecycle with one Sump, `s`, put in `state` through allowed moves. */
function inState(state: SumpState): Lifecycle {
  const l = new Lifecycle(undefined, () => T0, quiet);
  l.provision("s");
  const path: Record<SumpState, SumpState[]> = {
    provisioning: [],
    active: ["active"],
    unreachable: ["active", "unreachable"],
    retired: ["retired"],
  };
  for (const step of path[state]) l.move("s", step, "setup");
  return l;
}

const ALLOWED: [SumpState, SumpState][] = [
  ["provisioning", "active"],
  ["provisioning", "retired"],
  ["active", "unreachable"],
  ["unreachable", "active"],
  ["active", "retired"],
  ["unreachable", "retired"],
];

describe("br-SUMP-000011-sJpO9KMY: the transitions", () => {
  it("allows exactly the six decided transitions", () => {
    const table = STATES.flatMap((from) =>
      TRANSITIONS[from].map((to) => [from, to] as [SumpState, SumpState]),
    );
    expect(table.sort()).toEqual([...ALLOWED].sort());
  });

  const pairs = STATES.flatMap((from) =>
    STATES.filter((to) => to !== from).map((to) => [from, to] as [SumpState, SumpState]),
  );

  it.each(pairs)("%s → %s", (from, to) => {
    const l = inState(from);
    const heard: StateRecord[] = [];
    l.subscribe((r) => heard.push(r));
    const allowed = ALLOWED.some(([a, b]) => a === from && b === to);
    if (allowed) {
      expect(l.move("s", to, "test").state).toBe(to);
      expect(heard).toEqual([{ id: "s", state: to, since: T0.toISOString(), reason: "test" }]);
    } else {
      expect(() => l.move("s", to, "test")).toThrow(TransitionError);
      expect(l.get("s")?.state).toBe(from);
      expect(heard).toEqual([]);
    }
  });

  it("is silent when told a state the Sump is already in", () => {
    const l = inState("active");
    const heard: StateRecord[] = [];
    l.subscribe((r) => heard.push(r));
    l.move("s", "active", "again");
    l.reachable("s", "again");
    expect(heard).toEqual([]);
  });

  it("refuses to provision a Sump it knows, or to move one it does not", () => {
    const l = inState("active");
    expect(() => l.provision("s")).toThrow(TransitionError);
    expect(() => l.move("x", "active", "?")).toThrow(/not known/);
  });
});

describe("br-SUMP-000011-sJpO9KMY: one registry, seeded from the catalog", () => {
  it("starts live Sumps unreachable and retired ones retired", () => {
    const a = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "a" });
    const b = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "b" });
    catalog.retire(b.id, T0);
    const l = new Lifecycle(catalog, () => T0, quiet);
    expect(l.get(a.id)?.state).toBe("unreachable");
    expect(l.get(b.id)).toMatchObject({ state: "retired", since: T0.toISOString() });
  });

  it("retires in the catalog when a Sump is retired", () => {
    const a = catalog.recordConnect({ kind: "remote", sumpPort: 1, sshTarget: "a" });
    const l = new Lifecycle(catalog, () => T0, quiet);
    l.move(a.id, "retired", "uninstalled");
    expect(catalog.get(a.id)?.retiredAt).toBe(T0.toISOString());
  });

  it("adds a Sump it hears about for the first time, unreachable then active", () => {
    const l = new Lifecycle(undefined, () => T0, quiet);
    const heard: SumpState[] = [];
    l.subscribe((r) => heard.push(r.state));
    l.reachable("local", "answered");
    expect(heard).toEqual(["unreachable", "active"]);
  });

  it("leaves retired and provisioning Sumps alone when calls fail", () => {
    const l = inState("retired");
    expect(l.reachable("s", "answered")).toBeUndefined();
    const p = inState("provisioning");
    expect(p.unreachable("s", "silent")).toBeUndefined();
    expect(p.get("s")?.state).toBe("provisioning");
  });
});

describe("br-SUMP-000011-sJpO9KMY: the health probe", () => {
  it("makes an answering Sump active and a silent one unreachable", async () => {
    const up = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok"}');
    });
    const down = await serve(neverAnswers);
    servers.push(up, down);
    const l = new Lifecycle(undefined, () => T0, quiet);
    l.unreachable("up", "start");
    l.reachable("down", "start");
    const probe = new HealthProbe(l, (id) => (id === "up" ? up.sump : down.sump), {
      timeoutMs: 100,
    });
    await probe.probeOnce();
    expect(l.get("up")?.state).toBe("active");
    expect(l.get("down")?.state).toBe("unreachable");
  });

  it("counts any answer, even an error status, as reachable", async () => {
    const refusing = await serve((_req, res) => {
      res.writeHead(503);
      res.end();
    });
    servers.push(refusing);
    const l = new Lifecycle(undefined, () => T0, quiet);
    l.unreachable("s", "start");
    await new HealthProbe(l, () => refusing.sump).probeOnce();
    expect(l.get("s")).toMatchObject({ state: "active", reason: "answered /health with 503" });
  });

  it("never overlaps probes of one Sump, and skips Sumps it cannot resolve", async () => {
    let calls = 0;
    const slow = await serve(() => {
      calls += 1;
    });
    servers.push(slow);
    const l = new Lifecycle(undefined, () => T0, quiet);
    l.unreachable("s", "start");
    l.unreachable("remote", "start");
    const probe = new HealthProbe(l, (id) => (id === "s" ? slow.sump : undefined), {
      timeoutMs: 150,
    });
    const before = l.get("remote");
    await Promise.all([probe.probeOnce(), probe.probeOnce()]);
    expect(calls).toBe(1);
    expect(l.get("remote")).toEqual(before);
  });
});
