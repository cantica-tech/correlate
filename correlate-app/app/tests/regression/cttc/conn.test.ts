/**
 * Regression corpus of cttc's bugs: connection, startup and identity (CONN).
 *
 * One test per cttc bug whose behavior the app owns (br-BUILD-000006-sJpO9KMY).
 * Each is a to-do placeholder until its roadmap item builds the code; then a
 * strict expected failure (`it.fails`) until the code exists; then a passing
 * test. See README.md in this folder for the whole corpus.
 */
import { afterEach, describe, expect, it } from "vitest";
import { download, request, stream } from "../../../main/src/sump/client.js";
import { SumpTimeoutError } from "../../../main/src/sump/errors.js";
import {
  neverAnswers,
  serve,
  stallsAfterFirstChunk,
  type TestServer,
} from "../../../main/src/sump/tests/servers.js";

const quiet = { warn: () => {} };
const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

describe("br-CONN-000005-sJpO9KMY", () => {
  // BUG-000020-uKKrzikI, High (roadmap Item 8, RM-000009-sJpO9KMY): cttc's
  // upload, segment flush, metrics and event downloads bypassed its bounded
  // helpers and could hang forever on a stalled gateway. Every kind of call
  // now ends in a timeout against a stalled Sump.
  it("cttc BUG-000020: Raw fetches to the gateway have no timeout", async () => {
    const silent = await serve(neverAnswers);
    const stalledBody = await serve(stallsAfterFirstChunk("application/octet-stream", "x"));
    const stalledStream = await serve(stallsAfterFirstChunk("text/event-stream", ": hi\n\n"));
    servers.push(silent, stalledBody, stalledStream);

    const outcomes = await Promise.allSettled([
      request(silent.sump, "POST", "/upload", { body: {}, timeoutMs: 100, logger: quiet }),
      download(silent.sump, "/metrics", () => {}, { idleMs: 100, logger: quiet }),
      download(stalledBody.sump, "/metrics", () => {}, { idleMs: 100, logger: quiet }),
      stream(stalledStream.sump, "/live", () => {}, { idleMs: 100, logger: quiet }).done,
    ]);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") expect(outcome.reason).toBeInstanceOf(SumpTimeoutError);
    }
  });
});
