/**
 * Adding a log-sump stream from the app (br-STREAM-000012-sJpO9KMY,
 * REQ-000057-sJpO9KMY): its hosts asked through the Sump, the stream added with
 * its kind, the key sent to the Sump only; a Sump without the plugin said plainly.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ShellBridge, SumpRequester } from "../../shell/bridge.js";
import { addLogSumpStream, logSumpHosts } from "../api.js";
import { logSumpMessage, NEW_LOGSUMP, StreamsDialog } from "../StreamsDialog.js";

function requester(reply: unknown) {
  const sent: unknown[] = [];
  const request = (async (message: unknown) => {
    sent.push(message);
    return { ok: true, value: reply };
  }) as unknown as SumpRequester;
  return { sent, request };
}

describe("br-STREAM-000012-sJpO9KMY: a log-sump stream from the app", () => {
  it("asks the Sump for the log-sump's hosts, the key in that call only", async () => {
    const { sent, request } = requester({
      hosts: [{ id: "prod", host: "ssh://prod", enabled: true }],
    });
    expect(await logSumpHosts(request, "https://logs:8080", "k1")).toEqual({
      ok: true,
      value: [{ id: "prod", host: "ssh://prod", enabled: true }],
    });
    expect(sent).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/plugins/logsump/catalog",
        body: { url: "https://logs:8080", api_key: "k1" },
      }),
    ]);
  });

  it("adds the chosen host as a logsump stream, private if asked", async () => {
    const { sent, request } = requester({ id: "logsump:prod@logs:8080" });
    await addLogSumpStream(request, "https://logs:8080", "k1", "prod", true);
    expect(sent).toEqual([
      expect.objectContaining({
        method: "POST",
        path: "/streams",
        body: {
          kind: "logsump",
          url: "https://logs:8080",
          api_key: "k1",
          docker_host: "prod",
          private: true,
        },
      }),
    ]);
  });

  it("offers it beside New, over SSH, and says a Sump without the plugin plainly", () => {
    expect(logSumpMessage("Not Found")).toBe("This Sump has no log-sump plugin");
    expect(logSumpMessage("log-sump at x refused the API key")).toBe(
      "log-sump at x refused the API key",
    );
    const out = renderToStaticMarkup(
      <StreamsDialog bridge={{ sump: {} } as ShellBridge} mode={null} onClose={() => {}} />,
    );
    expect(out).toContain(`<option value="${NEW_LOGSUMP}">New, from a log-sump…</option>`);
  });
});
