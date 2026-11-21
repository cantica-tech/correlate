/**
 * Local HTTP servers for the Sump client tests: each test gets one on a free
 * loopback port, closed after the test with every connection it holds,
 * stalled ones included.
 */
import { createServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import type { Sump } from "../errors.js";

/** A running test server and the Sump that points at it. */
export interface TestServer {
  sump: Sump;
  close(): Promise<void>;
}

/** Start a server answering with `handler`. */
export async function serve(handler: RequestListener): Promise<TestServer> {
  const server: Server = createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    sump: { name: "test", baseUrl: `http://127.0.0.1:${port}` },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A handler that accepts the request and never answers. */
export const neverAnswers: RequestListener = () => {};

/** A handler that sends headers and a first chunk, then nothing. */
export function stallsAfterFirstChunk(contentType: string, first: string): RequestListener {
  return (_req, res) => {
    res.writeHead(200, { "content-type": contentType });
    res.write(first);
  };
}

/** Milliseconds since `start`. */
export function since(start: number): number {
  return performance.now() - start;
}
