/**
 * b8g runtime constants.
 *
 * Everything the engine talks about is addressed through a 16-bit *tag*.
 * A tag is the only thing a component can observe about a value that lives
 * outside its own context: the value itself stays behind a capability handle.
 */

/** Kind of a value addressed through a handle. */
export const Tag = Object.freeze({
  Null: 0x00,
  Bool: 0x01,
  Int: 0x02,
  Float: 0x03,
  String: 0x04,
  Bytes: 0x05,
  Array: 0x06,
  Map: 0x07,
  /** A reference to a memory region (shared or private). */
  Memory: 0x08,
  /** A reference to another capability handle. */
  Handle: 0x09,
  /** A callable component export. */
  Function: 0x0a,
  /** A hosted stream (readable/writable byte stream). */
  Stream: 0x0b,
  /** An error object travelling between contexts. */
  Error: 0x0c,
});

export const TagName = Object.freeze(
  Object.fromEntries(Object.entries(Tag).map(([k, v]) => [v, k])),
);

/** Access rights a capability may carry. Rights are additive. */
export const Right = Object.freeze({
  READ: 1 << 0,
  WRITE: 1 << 1,
  EXEC: 1 << 2,
  TRANSFER: 1 << 3,
  /** May hand the capability to a third context. */
  GRANT: 1 << 4,
});

export const RightName = Object.freeze({
  [Right.READ]: 'read',
  [Right.WRITE]: 'write',
  [Right.EXEC]: 'exec',
  [Right.TRANSFER]: 'transfer',
  [Right.GRANT]: 'grant',
});

export function rightsToString(mask) {
  const out = [];
  for (const [bit, name] of Object.entries(RightName)) {
    if (mask & Number(bit)) out.push(name);
  }
  return out.length ? out.join('|') : 'none';
}

/** Instruction set of the binary stack (see src/runtime/isa.mjs). */
export const Op = Object.freeze({
  NOP: 0x00,
  PUSH: 0x01,
  POP: 0x02,
  DUP: 0x03,
  SWAP: 0x04,
  LOAD: 0x05,
  STORE: 0x06,
  ADD: 0x10,
  SUB: 0x11,
  MUL: 0x12,
  DIV: 0x13,
  MOD: 0x14,
  NEG: 0x15,
  BAND: 0x16,
  BOR: 0x17,
  BXOR: 0x18,
  SHL: 0x19,
  SHR: 0x1a,
  EQ: 0x20,
  NE: 0x21,
  LT: 0x22,
  LE: 0x23,
  GT: 0x24,
  GE: 0x25,
  NOT: 0x26,
  JMP: 0x30,
  JZ: 0x31,
  JNZ: 0x32,
  CALL: 0x33,
  RET: 0x34,
  /** Read `len` bytes from a memory handle onto the stack. */
  MLOAD: 0x40,
  /** Write bytes at the top of the stack into a memory handle. */
  MSTORE: 0x41,
  /** Invoke a component export through a function handle. */
  CALLH: 0x42,
  /** Emit an event on a stream handle. */
  EMIT: 0x43,
  HALT: 0xff,
});

export const OpName = Object.freeze(
  Object.fromEntries(Object.entries(Op).map(([k, v]) => [v, k])),
);

/** Snapshot blob layout (compatible with the v8 snapshot framing). */
export const SNAPSHOT = Object.freeze({
  MAGIC: 0x4238_4730, // "B8G0"
  VERSION: 1,
  HEADER_SIZE: 128,
  CHECKSUM_ALGO: 'fnv1a32',
});
