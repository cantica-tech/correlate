/**
 * A small, read-only zip reader for cttc's archives (REQ-000033-sJpO9KMY
 * Requirement 1): the central directory, stored and deflated entries, no
 * zip64, no encryption. Limits are checked before anything is inflated, so
 * a crafted file cannot make the app inflate more than it allows.
 */
import { inflateRawSync } from "node:zlib";

/** What a zip may hold, at most. */
export interface ZipLimits {
  entries: number;
  /** Every entry's unpacked bytes, together. */
  bytes: number;
}

/** cttc's archives are small; these leave room (REQ-000033-sJpO9KMY). */
export const DEFAULT_LIMITS: ZipLimits = { entries: 10_000, bytes: 200 * 1024 * 1024 };

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** The entries of `buf`, by name; throws with the reason when it is not a zip this reads. */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_LIMITS): Map<string, Buffer> {
  const end = findEnd(buf);
  const count = buf.readUInt16LE(end + 10);
  const dirOffset = buf.readUInt32LE(end + 16);
  if (count === 0xffff || dirOffset === 0xffffffff) throw new Error("a zip64 archive is not read");
  if (count > limits.entries) throw new Error(`more than ${limits.entries} entries`);
  const entries = new Map<string, Buffer>();
  let at = dirOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== CENTRAL) {
      throw new Error("a damaged zip directory");
    }
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const extraLength = buf.readUInt16LE(at + 30);
    const commentLength = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;
    if (flags & 1) throw new Error(`${name} is encrypted`);
    total += size;
    if (total > limits.bytes) throw new Error(`more than ${limits.bytes} bytes unpacked`);
    if (name.endsWith("/")) continue;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== LOCAL) {
      throw new Error(`a damaged entry: ${name}`);
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    if (data.length !== packed) throw new Error(`a cut entry: ${name}`);
    if (method === 0) entries.set(name, Buffer.from(data));
    else if (method === 8) entries.set(name, inflateRawSync(data, { maxOutputLength: size || 1 }));
    else throw new Error(`${name} uses compression method ${method}`);
  }
  return entries;
}

/** The end-of-central-directory record's offset; throws when there is none. */
function findEnd(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - 22 - 0xffff);
  for (let at = buf.length - 22; at >= lowest; at--) {
    if (buf.readUInt32LE(at) === EOCD) return at;
  }
  throw new Error("not a zip archive");
}
