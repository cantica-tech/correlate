/**
 * Who added a data stream, and Private (REQ-000053-sJpO9KMY step 2,
 * br-STREAM-000009-sJpO9KMY): said in Current Status, sent when adding a
 * stream and when its switch changes, a refusal said in the Sump's words.
 */
import { describe, expect, it } from "vitest";
import type { SumpRequester } from "../../shell/bridge.js";
import { streamRows } from "../active.js";
import { addStream, type Stream, setPrivate } from "../api.js";

const lab: Stream = { id: "ssh:ops@lab:22", kind: "ssh", label: "ops@lab", following: 1 };

function requester(reply: unknown, ok = true) {
  const sent: unknown[] = [];
  const request = (async (message: unknown) => {
    sent.push(message);
    return ok
      ? { ok: true, value: reply }
      : {
          ok: false,
          error: { kind: "http", message: "403", status: 403, detail: { detail: reply } },
        };
  }) as unknown as SumpRequester;
  return { sent, request };
}

describe("br-STREAM-000009-sJpO9KMY: the app shows who added a stream and Private", () => {
  it("says them in Current Status, when the Sump tells them", () => {
    expect(streamRows({ ...lab, created_by: "bob", private: true })).toEqual(
      expect.arrayContaining([
        ["Added by", "bob"],
        ["Private", "yes: only you and the owner"],
      ]),
    );
    expect(streamRows({ ...lab, created_by: "bob", private: false })).toContainEqual([
      "Private",
      "no",
    ]);
    expect(streamRows(lab).map(([name]) => name)).not.toContain("Private");
  });

  it("sends Private when adding a stream, shared by default", async () => {
    const { sent, request } = requester(lab);
    await addStream(request, "ops@lab", 22, true);
    await addStream(request, "ops@lab", 22);
    expect(sent).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/streams",
        body: { target: "ops@lab", port: 22, private: true },
      }),
      expect.objectContaining({ body: { target: "ops@lab", port: 22, private: false } }),
    ]);
  });

  it("changes it with its own call; a refusal is said in the Sump's words", async () => {
    const ok = requester({ private: true });
    expect(await setPrivate(ok.request, lab.id, true)).toEqual({
      ok: true,
      value: { private: true },
    });
    expect(ok.sent).toEqual([
      expect.objectContaining({
        method: "PUT",
        path: "/streams/ssh%3Aops%40lab%3A22/private",
        body: { private: true },
      }),
    ]);
    const refused = requester(
      "only who added this data stream, or the Sump's owner, can change it",
      false,
    );
    expect(await setPrivate(refused.request, lab.id, true)).toEqual({
      ok: false,
      message: "only who added this data stream, or the Sump's owner, can change it",
    });
  });
});
