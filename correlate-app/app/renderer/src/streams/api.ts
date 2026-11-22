/**
 * The data streams' calls to the window's Sump (REQ-000025-sJpO9KMY), through
 * the Sump bridge only (br-CONN-000008-sJpO9KMY): the Sump keeps the streams
 * and what is followed on each, and collects it.
 */
import type { SecondaryInfo, SumpErrorInfo, SumpRequester } from "../shell/bridge.js";

/** A data stream, as the Sump lists it. */
export interface Stream {
  id: string;
  /** `file`: an opened file in the analysis view (REQ-000033-sJpO9KMY). */
  kind: "self" | "ssh" | "file";
  label: string;
  /** An SSH stream's host (REQ-000032-sJpO9KMY: the host block's title). */
  host?: string | null;
  /** Paused by Close Data Streams (REQ-000027-sJpO9KMY). */
  paused?: boolean;
  /** How many containers and services it follows. */
  following?: number;
  /** What it follows (REQ-000028-sJpO9KMY). */
  followed?: FollowedSet;
  /** Promoted: the secondary Sump that collects it (REQ-000052-sJpO9KMY). */
  secondary?: SecondaryInfo;
  /** Who added it (br-STREAM-000006-sJpO9KMY); the Sump's owner for "self". */
  created_by?: string | null;
  /** Seen only by who added it and the Sump's owner (br-STREAM-000007-sJpO9KMY). */
  private?: boolean;
  /** Whether this user may change it (br-STREAM-000008-sJpO9KMY). */
  may_change?: boolean;
}

/** Whether a promoted stream's secondary answers its parent now. */
export interface SecondaryStatus {
  secondary: SecondaryInfo;
  reachable: boolean;
  error: string | null;
}

/** A running container. */
export interface Container {
  id: string;
  name: string;
  image: string;
}

/** A Swarm service. */
export interface Service {
  name: string;
  replicas: string;
}

/** What is followed on a stream: names. */
export interface FollowedSet {
  containers: string[];
  services: string[];
}

/** What runs on a stream, and what is followed there. */
export interface Targets {
  containers: Container[];
  /** None unless the host is a Swarm manager. */
  services: Service[] | null;
  followed: FollowedSet;
}

/** A call's outcome: its value, or what went wrong, said for people. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** What went wrong, from the Sump's own words where it gave some. */
export function sayError(error: SumpErrorInfo): string {
  if (error.kind === "http") {
    const detail = (error.detail as { detail?: unknown } | undefined)?.detail;
    if (typeof detail === "string") return detail;
  }
  return error.message;
}

async function call<T>(
  request: SumpRequester,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<Outcome<T>> {
  const reply = await request({ method, path, body, timeoutMs });
  return reply.ok
    ? { ok: true, value: reply.value as T }
    : { ok: false, message: sayError(reply.error) };
}

const streamPath = (id: string) => `/streams/${encodeURIComponent(id)}`;

/** The Sump's data streams. */
export async function listStreams(request: SumpRequester): Promise<Outcome<Stream[]>> {
  const r = await call<{ streams: Stream[] }>(request, "GET", "/streams");
  return r.ok ? { ok: true, value: r.value.streams } : r;
}

/** Add a stream over SSH; the Sump first reaches Docker there with its own key. */
export function addStream(request: SumpRequester, target: string, port: number, isPrivate = false) {
  return call<Stream>(request, "POST", "/streams", { target, port, private: isPrivate });
}

/** Make a stream private or shared (br-STREAM-000007-sJpO9KMY); its creator's and the owner's. */
export function setPrivate(request: SumpRequester, id: string, isPrivate: boolean) {
  return call<{ private: boolean }>(request, "PUT", `${streamPath(id)}/private`, {
    private: isPrivate,
  });
}

/** The Sump's public key, for the host's `authorized_keys`. */
export async function sumpPublicKey(request: SumpRequester): Promise<Outcome<string>> {
  const r = await call<{ public_key: string }>(request, "GET", "/plugins/ssh/public-key");
  return r.ok ? { ok: true, value: r.value.public_key } : r;
}

/** What runs on a stream and what is followed there. */
export function streamTargets(request: SumpRequester, id: string) {
  return call<Targets>(request, "GET", `${streamPath(id)}/targets`);
}

/** Make a stream's followed set exactly `followed` (br-STREAM-000002-sJpO9KMY). */
export function setFollowed(request: SumpRequester, id: string, followed: FollowedSet) {
  return call<FollowedSet>(request, "PUT", `${streamPath(id)}/followed`, followed);
}

/** Stop a stream's collection and forget it (br-STREAM-000004-sJpO9KMY); its records stay. */
export function removeStream(request: SumpRequester, id: string) {
  return call<null>(request, "DELETE", streamPath(id));
}

/** Close Data Streams (`true`): collection stops, the followed set kept. */
export function pauseStream(request: SumpRequester, id: string, paused: boolean) {
  return call<{ paused: boolean }>(request, "PUT", `${streamPath(id)}/paused`, { paused });
}

/** Whether a promoted stream's secondary answers the Sump now (br-FED-000004-sJpO9KMY). */
export function secondaryStatus(request: SumpRequester, id: string) {
  return call<SecondaryStatus>(request, "GET", `${streamPath(id)}/secondary`);
}
