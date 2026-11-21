/**
 * Parser for server-sent event streams (REQ-000007-sJpO9KMY Requirement 2).
 *
 * Fed raw bytes as they arrive, it returns the complete events they finish.
 * Comment lines, such as the Sump's `: keep-alive` heartbeat
 * (br-CONN-000009-sJpO9KMY), produce no event: the client counts their bytes
 * as signs of life, nothing more.
 */

/** One event: its type (`message` when unnamed), its data lines joined, its id. */
export interface SumpEvent {
  event: string;
  data: string;
  id?: string;
}

/** Turns an SSE byte stream into events, keeping partial lines between chunks. */
export class SseParser {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;

  /** Feed the next chunk; returns the events it completes, in order. */
  push(chunk: Uint8Array): SumpEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const events: SumpEvent[] = [];
    let end = this.buffer.search(/\r\n|\r|\n/);
    // A "\r" ending the buffer may be the first half of "\r\n": wait for more.
    while (end !== -1 && !(end === this.buffer.length - 1 && this.buffer[end] === "\r")) {
      const line = this.buffer.slice(0, end);
      const newline = this.buffer.startsWith("\r\n", end) ? 2 : 1;
      this.buffer = this.buffer.slice(end + newline);
      const event = this.line(line);
      if (event) events.push(event);
      end = this.buffer.search(/\r\n|\r|\n/);
    }
    return events;
  }

  /** Handle one line; a blank line ends the event being built. */
  private line(line: string): SumpEvent | undefined {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return undefined;
      }
      const event: SumpEvent = { event: this.event || "message", data: this.data.join("\n") };
      if (this.id !== undefined) event.id = this.id;
      this.event = "";
      this.data = [];
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") this.id = value;
    return undefined;
  }
}
