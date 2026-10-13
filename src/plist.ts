/**
 * A reader for Apple's binary property lists ("bplist00"), the format Safari
 * writes ~/Library/Safari/Bookmarks.plist in. It decodes the types a plist can
 * hold into plain values: dicts become objects, arrays and sets arrays, dates
 * JS Dates, data Buffers, UIDs numbers. Written here rather than pulled in as a
 * dependency because the format is small and fixed, and mnemos must read it on
 * every platform (CI runs on Linux and Windows too).
 *
 * Layout: an 8-byte header, the objects, an offset table, and a 32-byte
 * trailer giving the sizes of offsets and object references, the object count,
 * the top object and where the offset table starts.
 */

/** Seconds between the Unix epoch and Apple's (2001-01-01 UTC). */
const APPLE_EPOCH_MS = 978_307_200_000;

/**
 * Deeper nesting than this is a corrupt or hostile file, not a bookmark tree:
 * each folder level is two plist levels (a dict and its Children array), so
 * this allows 256 nested folders while staying far inside the call stack,
 * which the recursive decoder would overflow at a few thousand levels.
 */
const MAX_DEPTH = 512;

export function isBinaryPlist(buf: Buffer): boolean {
  return buf.length >= 8 && buf.toString("latin1", 0, 8) === "bplist00";
}

export function parseBinaryPlist(buf: Buffer): unknown {
  if (!isBinaryPlist(buf)) throw new Error('missing the "bplist00" header');
  if (buf.length < 8 + 32) throw new Error("too short to hold a trailer");
  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6];
  const refSize = buf[trailer + 7];
  const count = uint(buf, trailer + 8, 8);
  const top = uint(buf, trailer + 16, 8);
  const tableStart = uint(buf, trailer + 24, 8);
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) {
    throw new Error("bad offset or reference size in the trailer");
  }
  if (top >= count || tableStart < 8 || tableStart + count * offsetSize > trailer) {
    throw new Error("the trailer points outside the file");
  }

  // Objects are values, so one referenced twice decodes once. Memoizing keeps
  // a file that shares objects heavily linear; `pending` catches cycles.
  const done = new Map<number, unknown>();
  const pending = new Set<number>();

  const read = (ref: number, depth: number): unknown => {
    if (ref >= count) throw new Error(`object reference ${ref} out of range`);
    if (done.has(ref)) return done.get(ref);
    if (pending.has(ref)) throw new Error("an object contains itself");
    if (depth > MAX_DEPTH) throw new Error("objects nested too deeply");
    pending.add(ref);
    const value = decode(uint(buf, tableStart + ref * offsetSize, offsetSize), depth);
    pending.delete(ref);
    done.set(ref, value);
    return value;
  };

  const decode = (offset: number, depth: number): unknown => {
    if (offset < 8 || offset >= tableStart) throw new Error(`object offset ${offset} out of range`);
    const marker = buf[offset];
    const kind = marker >> 4;
    const info = marker & 0x0f;

    // Variable-length objects: the low nibble is the length, or 0xF and an
    // integer object follows with the real length.
    const sized = (): { length: number; start: number } => {
      if (info !== 0x0f) return { length: info, start: offset + 1 };
      const intMarker = buf[offset + 1];
      if (intMarker >> 4 !== 0x1) throw new Error("bad length marker");
      const bytes = 1 << (intMarker & 0x0f);
      return { length: integer(buf, offset + 2, bytes), start: offset + 2 + bytes };
    };
    const span = (start: number, bytes: number): Buffer => {
      if (start + bytes > tableStart) throw new Error("object runs past the object area");
      return buf.subarray(start, start + bytes);
    };
    const refs = (start: number, n: number): number[] => {
      const raw = span(start, n * refSize);
      return Array.from({ length: n }, (_, i) => uint(raw, i * refSize, refSize));
    };

    switch (kind) {
      case 0x0:
        if (marker === 0x00) return null;
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        throw new Error(`unknown marker 0x${marker.toString(16)}`);
      case 0x1:
        return integer(buf, offset + 1, 1 << info);
      case 0x2:
        if (info === 2) return span(offset + 1, 4).readFloatBE(0);
        if (info === 3) return span(offset + 1, 8).readDoubleBE(0);
        throw new Error(`unsupported real size 2^${info}`);
      case 0x3:
        return new Date(APPLE_EPOCH_MS + span(offset + 1, 8).readDoubleBE(0) * 1000);
      case 0x4: {
        const { length, start } = sized();
        return Buffer.from(span(start, length));
      }
      case 0x5: {
        const { length, start } = sized();
        return span(start, length).toString("latin1");
      }
      case 0x6: {
        const { length, start } = sized();
        // UTF-16 big-endian; Node decodes only little-endian, so swap a copy.
        return Buffer.from(span(start, length * 2)).swap16().toString("utf16le");
      }
      case 0x7: {
        const { length, start } = sized();
        return span(start, length).toString("utf-8");
      }
      case 0x8:
        return uint(buf, offset + 1, info + 1);
      case 0xa:
      case 0xc: {
        const { length, start } = sized();
        return refs(start, length).map((r) => read(r, depth + 1));
      }
      case 0xd: {
        const { length, start } = sized();
        const keys = refs(start, length);
        const values = refs(start + length * refSize, length);
        const dict: Record<string, unknown> = Object.create(null);
        keys.forEach((k, i) => {
          const key = read(k, depth + 1);
          if (typeof key !== "string") throw new Error("a dictionary key is not a string");
          dict[key] = read(values[i], depth + 1);
        });
        return dict;
      }
      default:
        throw new Error(`unknown marker 0x${marker.toString(16)}`);
    }
  };

  return read(top, 0);
}

/** An unsigned big-endian integer of 1–8 bytes, which must fit a JS number. */
function uint(buf: Buffer, offset: number, bytes: number): number {
  if (offset + bytes > buf.length) throw new Error("read past the end of the file");
  let value = 0n;
  for (let i = 0; i < bytes; i++) value = (value << 8n) | BigInt(buf[offset + i]);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("integer too large");
  return Number(value);
}

/**
 * A plist integer object's payload: 1, 2 and 4 bytes are unsigned, 8 bytes
 * signed, 16 bytes a 128-bit value of which only the low 8 bytes are kept.
 */
function integer(buf: Buffer, offset: number, bytes: number): number {
  if (offset + bytes > buf.length) throw new Error("read past the end of the file");
  if (bytes === 16) return integer(buf, offset + 8, 8);
  if (bytes === 8) return Number(buf.readBigInt64BE(offset));
  if (bytes === 1 || bytes === 2 || bytes === 4) return uint(buf, offset, bytes);
  throw new Error(`unsupported integer size ${bytes}`);
}
