import { SNAPSHOT } from './constants.mjs';
import { SnapshotError } from './errors.mjs';

/**
 * The b8g snapshot format.
 *
 * A snapshot is a single binary blob: a fixed 128-byte header followed by
 * length-prefixed, self-describing payload sections and, finally, a trailer
 * holding the raw bytes of every memory region (addressed by offset).
 *
 * Header layout (little-endian, 128 bytes):
 *   0   magic          u32   "B8G0"
 *   4   formatVersion  u16
 *   6   flags          u16   (bit 0 = rehashable)
 *   8   contextCount   u32   N
 *   12  reserved       u32
 *   16  checksum       u32   fnv1a32 over the payload
 *   20  payloadLength  u32
 *   24  nameLength     u16
 *   26  reserved       u16
 *   28  reserved       u32
 *   32  name           UTF-8, padded to 64 bytes
 *   96  sectionIndex   u32 x 8  offsets to payload sections
 *   128 payload ...
 *
 * The payload mirrors the v8 framing from the b8g README: a read-only section
 * followed by one section per context, then capability/component/stream
 * descriptors that name what the offsets point at.
 */

export const SECTION = Object.freeze({
  READONLY: 0,
  MEMORY: 1,
  CONTEXTS: 2,
  CAPABILITIES: 3,
  COMPONENTS: 4,
  STREAMS: 5,
  META: 6,
  RESERVED: 7,
});

export const NAME_OFFSET = 32;
export const NAME_FIELD_SIZE = 64;
export const SECTION_INDEX_OFFSET = 96;
export const SECTION_COUNT = 8;
export const PAYLOAD_OFFSET = SNAPSHOT.HEADER_SIZE; // 128

/** FNV-1a 32-bit checksum, matching the declared CHECKSUM_ALGO. */
export function fnv1a32(bytes) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i];
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function encodeSection(payload) {
  return new TextEncoder().encode(JSON.stringify(payload ?? {}));
}

/**
 * Serialise an engine state into a snapshot blob.
 *
 * @param {object} state
 * @param {string} [name]
 * @returns {Uint8Array}
 */
export function serializeSnapshot(state = {}, name = 'b8g-snapshot') {
  const sections = [
    encodeSection(state.readonly ?? { rehashable: state.rehashable !== false }),
    encodeSection(state.memory ?? {}),
    encodeSection(state.contexts ?? []),
    encodeSection(state.capabilities ?? []),
    encodeSection(state.components ?? []),
    encodeSection(state.streams ?? []),
    encodeSection(state.meta ?? {}),
    new Uint8Array(0),
  ];

  const blobs = (state.blobs ?? []).map((b) => ({
    id: b.id,
    bytes: b.bytes instanceof Uint8Array ? b.bytes : new Uint8Array(b.bytes),
  }));

  const nameBytes = new TextEncoder().encode(name).slice(0, NAME_FIELD_SIZE - 1);

  let cursor = PAYLOAD_OFFSET;
  const sectionOffsets = [];
  for (const section of sections) {
    sectionOffsets.push(cursor);
    cursor += section.length;
  }

  // Raw region bytes follow the sections, described by the trailer table.
  const blobTable = [];
  for (const blob of blobs) {
    blobTable.push({ id: blob.id, offset: cursor, length: blob.bytes.length });
    cursor += blob.bytes.length;
  }
  const payloadLength = cursor - PAYLOAD_OFFSET;

  const trailer = encodeSection({ blobTable });
  const total = cursor + 4 + trailer.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  dv.setUint32(0, SNAPSHOT.MAGIC, true);
  dv.setUint16(4, SNAPSHOT.VERSION, true);
  dv.setUint16(6, state.rehashable === false ? 0 : 1, true);
  dv.setUint32(8, state.contexts?.length ?? 0, true);
  dv.setUint32(16, 0, true); // checksum placeholder
  dv.setUint32(20, payloadLength, true);
  dv.setUint16(24, nameBytes.length, true);
  out.set(nameBytes, NAME_OFFSET);
  sectionOffsets.forEach((off, i) => dv.setUint32(SECTION_INDEX_OFFSET + i * 4, off, true));

  sections.forEach((section, i) => out.set(section, sectionOffsets[i]));
  blobs.forEach((blob, i) => out.set(blob.bytes, blobTable[i].offset));
  dv.setUint32(cursor, trailer.length, true);
  out.set(trailer, cursor + 4);

  dv.setUint32(16, fnv1a32(out.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + payloadLength)), true);
  return out;
}

/** Parse a snapshot blob back into an engine state object. */
export function deserializeSnapshot(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < PAYLOAD_OFFSET) throw new SnapshotError('blob too small', { length: u8.length });
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = dv.getUint32(0, true);
  if (magic !== SNAPSHOT.MAGIC) {
    throw new SnapshotError(`bad magic 0x${magic.toString(16)}`, { expected: SNAPSHOT.MAGIC });
  }
  const version = dv.getUint16(4, true);
  const flags = dv.getUint16(6, true);
  const contextCount = dv.getUint32(8, true);
  const checksum = dv.getUint32(16, true);
  const payloadLength = dv.getUint32(20, true);
  const nameLength = dv.getUint16(24, true);
  const name = new TextDecoder().decode(u8.subarray(NAME_OFFSET, NAME_OFFSET + nameLength));

  const payloadEnd = PAYLOAD_OFFSET + payloadLength;
  const checksumValid = fnv1a32(u8.subarray(PAYLOAD_OFFSET, payloadEnd)) === checksum;

  const offsets = [];
  for (let i = 0; i < SECTION_COUNT; i++) offsets.push(dv.getUint32(SECTION_INDEX_OFFSET + i * 4, true));
  const sectionAt = (index) => {
    const start = offsets[index];
    const end = index + 1 < SECTION_COUNT ? offsets[index + 1] : payloadEnd;
    if (start >= end) return {};
    return JSON.parse(new TextDecoder().decode(u8.subarray(start, end)));
  };

  let blobTable = [];
  if (payloadEnd + 4 <= u8.length) {
    const trailerLen = dv.getUint32(payloadEnd, true);
    if (payloadEnd + 4 + trailerLen <= u8.length) {
      const trailer = JSON.parse(
        new TextDecoder().decode(u8.subarray(payloadEnd + 4, payloadEnd + 4 + trailerLen)),
      );
      blobTable = trailer.blobTable ?? [];
    }
  }
  const blobs = blobTable.map((b) => ({ id: b.id, bytes: u8.slice(b.offset, b.offset + b.length) }));

  return {
    name,
    version,
    rehashable: (flags & 1) === 1,
    contextCount,
    checksum,
    checksumValid,
    payloadLength,
    readonly: sectionAt(SECTION.READONLY),
    memory: sectionAt(SECTION.MEMORY),
    contexts: sectionAt(SECTION.CONTEXTS),
    capabilities: sectionAt(SECTION.CAPABILITIES),
    components: sectionAt(SECTION.COMPONENTS),
    streams: sectionAt(SECTION.STREAMS),
    meta: sectionAt(SECTION.META),
    blobs,
  };
}

/** Human-readable header inspection without decoding the full payload. */
export function inspectSnapshot(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const payloadLength = dv.getUint32(20, true);
  const nameLength = dv.getUint16(24, true);
  return {
    magic: `0x${dv.getUint32(0, true).toString(16)}`,
    name: new TextDecoder().decode(u8.subarray(NAME_OFFSET, NAME_OFFSET + nameLength)),
    version: dv.getUint16(4, true),
    rehashable: (dv.getUint16(6, true) & 1) === 1,
    contextCount: dv.getUint32(8, true),
    checksum: dv.getUint32(16, true),
    payloadLength,
    totalSize: u8.length,
    checksumValid:
      fnv1a32(u8.subarray(PAYLOAD_OFFSET, PAYLOAD_OFFSET + payloadLength)) === dv.getUint32(16, true),
  };
}
