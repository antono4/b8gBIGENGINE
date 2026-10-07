import { Op, OpName } from './constants.mjs';
import { B8GError } from './errors.mjs';

/**
 * Operand shapes per opcode. The stack format is intentionally tiny and
 * directly executable: one opcode byte followed by fixed-width little-endian
 * operands, so a stack image can be mmap'ed and walked without tooling.
 */
const SHAPES = Object.freeze({
  [Op.NOP]: [],
  [Op.PUSH]: ['f64'],
  [Op.POP]: [],
  [Op.DUP]: [],
  [Op.SWAP]: [],
  [Op.LOAD]: ['u32'],
  [Op.STORE]: ['u32'],
  [Op.ADD]: [],
  [Op.SUB]: [],
  [Op.MUL]: [],
  [Op.DIV]: [],
  [Op.MOD]: [],
  [Op.NEG]: [],
  [Op.BAND]: [],
  [Op.BOR]: [],
  [Op.BXOR]: [],
  [Op.SHL]: [],
  [Op.SHR]: [],
  [Op.EQ]: [],
  [Op.NE]: [],
  [Op.LT]: [],
  [Op.LE]: [],
  [Op.GT]: [],
  [Op.GE]: [],
  [Op.NOT]: [],
  [Op.JMP]: ['u32'],
  [Op.JZ]: ['u32'],
  [Op.JNZ]: ['u32'],
  [Op.CALL]: ['u32'],
  [Op.RET]: [],
  [Op.MLOAD]: ['u16', 'u32'],
  [Op.MSTORE]: ['u16', 'u32'],
  [Op.CALLH]: ['u16', 'u8'],
  [Op.EMIT]: ['u16'],
  [Op.HALT]: [],
});

const WIDTH = { u8: 1, u16: 2, u32: 4, f64: 8 };

function writeOperand(dv, offset, kind, value) {
  switch (kind) {
    case 'u8':
      dv.setUint8(offset, value & 0xff);
      return offset + 1;
    case 'u16':
      dv.setUint16(offset, value & 0xffff, true);
      return offset + 2;
    case 'u32':
      dv.setUint32(offset, value >>> 0, true);
      return offset + 4;
    case 'f64':
      dv.setFloat64(offset, Number(value), true);
      return offset + 8;
    default:
      throw new B8GError(`unknown operand kind ${kind}`, 'BAD_OPERAND');
  }
}

function readOperand(dv, offset, kind) {
  switch (kind) {
    case 'u8':
      return [dv.getUint8(offset), offset + 1];
    case 'u16':
      return [dv.getUint16(offset, true), offset + 2];
    case 'u32':
      return [dv.getUint32(offset, true), offset + 4];
    case 'f64':
      return [dv.getFloat64(offset, true), offset + 8];
    default:
      throw new B8GError(`unknown operand kind ${kind}`, 'BAD_OPERAND');
  }
}

function sizeOf(op) {
  const shape = SHAPES[op];
  if (!shape) throw new B8GError(`unknown opcode 0x${op.toString(16)}`, 'BAD_OPCODE');
  return 1 + shape.reduce((n, k) => n + WIDTH[k], 0);
}

/**
 * Assemble a textual/array program into a binary stack image.
 *
 * @param {Array<[string, ...any]>} program e.g. [['PUSH', 2], ['PUSH', 3], ['ADD'], ['HALT']]
 * @returns {{bytes: Uint8Array, instructions: object[], labels: Map<string, number>}}
 */
export function assemble(program) {
  const instructions = [];
  const labels = new Map();
  let pc = 0;

  // Pass 1: resolve labels and lay out instructions.
  const resolved = [];
  for (const entry of program) {
    if (typeof entry === 'string') {
      if (!entry.endsWith(':')) throw new B8GError(`bad label "${entry}"`, 'BAD_LABEL');
      labels.set(entry.slice(0, -1), pc);
      continue;
    }
    const [mnemonic, ...operands] = entry;
    const op = Op[String(mnemonic).toUpperCase()];
    if (op === undefined) throw new B8GError(`unknown mnemonic ${mnemonic}`, 'BAD_MNEMONIC');
    const size = sizeOf(op);
    resolved.push({ op, operands, pc, size });
    pc += size;
  }

  // Pass 2: encode, resolving symbolic operands (labels) to absolute pcs.
  const bytes = new Uint8Array(pc);
  const dv = new DataView(bytes.buffer);
  let offset = 0;
  for (const inst of resolved) {
    bytes[offset] = inst.op;
    offset += 1;
    const shape = SHAPES[inst.op];
    if (inst.operands.length !== shape.length) {
      throw new B8GError(
        `${OpName[inst.op]} expects ${shape.length} operand(s), got ${inst.operands.length}`,
        'BAD_ARITY',
      );
    }
    shape.forEach((kind, i) => {
      let value = inst.operands[i];
      if (typeof value === 'string' && labels.has(value)) value = labels.get(value);
      inst.operands[i] = value;
      offset = writeOperand(dv, offset, kind, value);
    });
    instructions.push({
      pc: inst.pc,
      op: inst.op,
      name: OpName[inst.op],
      operands: inst.operands,
      size: inst.size,
    });
  }

  return { bytes, instructions, labels };
}

/** Disassemble a binary stack image back into instruction objects. */
export function disassemble(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  let offset = 0;
  while (offset < u8.length) {
    const op = u8[offset];
    const shape = SHAPES[op];
    if (!shape) throw new B8GError(`unknown opcode 0x${op.toString(16)} at ${offset}`, 'BAD_OPCODE');
    let cursor = offset + 1;
    const operands = shape.map((kind) => {
      const [value, next] = readOperand(dv, cursor, kind);
      cursor = next;
      return value;
    });
    out.push({ pc: offset, op, name: OpName[op], operands, size: cursor - offset });
    offset = cursor;
  }
  return out;
}

export { SHAPES };
