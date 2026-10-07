import { Op } from './constants.mjs';
import { VmError } from './errors.mjs';
import { Right, Tag } from './constants.mjs';
import { disassemble } from './isa.mjs';

/**
 * A tiny stack machine that executes a binary stack image.
 *
 * It is deliberately minimal, but it is enough to demonstrate the b8g
 * primitive set: arithmetic, branches, memory loads/stores through handles and
 * capability-checked calls into component exports (`CALLH`).
 */
export class Vm {
  /**
   * @param {{bytes: Uint8Array, context?: import('./context.mjs').Context, limits?: object}} opts
   */
  constructor(opts = {}) {
    this.bytes = opts.bytes ?? new Uint8Array(0);
    this.context = opts.context ?? null;
    this.limits = { steps: 1_000_000, stack: 4096, ...(opts.limits ?? {}) };
    this.stack = [];
    this.frames = [];
    this.pc = 0;
    this.steps = 0;
    this.halted = false;
    this.trace = [];
    this.output = [];
    this.emitTrace = opts.trace ?? false;
    this._breakpoints = new Set(opts.breakpoints ?? []);
  }

  _push(value) {
    if (this.stack.length >= this.limits.stack) throw new VmError('stack overflow', { pc: this.pc });
    this.stack.push(value);
  }

  _pop() {
    if (!this.stack.length) throw new VmError('stack underflow', { pc: this.pc });
    return this.stack.pop();
  }

  _resolveMemory(index) {
    if (!this.context) throw new VmError('no context bound to vm', { pc: this.pc });
    const handle = this.context.byIndex(index);
    return handle;
  }

  run() {
    while (!this.halted && this.pc < this.bytes.length) {
      if (++this.steps > this.limits.steps) {
        throw new VmError('step limit exceeded', { steps: this.steps });
      }
      if (this._breakpoints.has(this.pc)) {
        return { reason: 'breakpoint', pc: this.pc };
      }
      this.step();
    }
    return { reason: 'halt', pc: this.pc, stack: this.stack };
  }

  step() {
    const start = this.pc;
    const op = this.bytes[this.pc];
    this.pc += 1;
    const dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const u8 = () => this.bytes[this.pc++];
    const u16 = () => {
      const v = dv.getUint16(this.pc, true);
      this.pc += 2;
      return v;
    };
    const u32 = () => {
      const v = dv.getUint32(this.pc, true);
      this.pc += 4;
      return v;
    };
    const f64 = () => {
      const v = dv.getFloat64(this.pc, true);
      this.pc += 8;
      return v;
    };

    switch (op) {
      case Op.NOP:
        break;
      case Op.PUSH:
        this._push(f64());
        break;
      case Op.POP:
        this._pop();
        break;
      case Op.DUP: {
        const v = this._pop();
        this._push(v);
        this._push(v);
        break;
      }
      case Op.SWAP: {
        const a = this._pop();
        const b = this._pop();
        this._push(a);
        this._push(b);
        break;
      }
      case Op.ADD:
        this._push(this._pop() + this._pop());
        break;
      case Op.SUB: {
        const b = this._pop();
        const a = this._pop();
        this._push(a - b);
        break;
      }
      case Op.MUL:
        this._push(this._pop() * this._pop());
        break;
      case Op.DIV: {
        const b = this._pop();
        const a = this._pop();
        if (b === 0) throw new VmError('division by zero', { pc: start });
        this._push(a / b);
        break;
      }
      case Op.MOD: {
        const b = this._pop();
        const a = this._pop();
        this._push(a % b);
        break;
      }
      case Op.NEG:
        this._push(-this._pop());
        break;
      case Op.BAND:
        this._push(this._pop() & this._pop());
        break;
      case Op.BOR:
        this._push(this._pop() | this._pop());
        break;
      case Op.BXOR:
        this._push(this._pop() ^ this._pop());
        break;
      case Op.SHL: {
        const b = this._pop();
        const a = this._pop();
        this._push(a << b);
        break;
      }
      case Op.SHR: {
        const b = this._pop();
        const a = this._pop();
        this._push(a >> b);
        break;
      }
      case Op.EQ:
        this._push(this._pop() === this._pop() ? 1 : 0);
        break;
      case Op.NE:
        this._push(this._pop() !== this._pop() ? 1 : 0);
        break;
      case Op.LT: {
        const b = this._pop();
        const a = this._pop();
        this._push(a < b ? 1 : 0);
        break;
      }
      case Op.LE: {
        const b = this._pop();
        const a = this._pop();
        this._push(a <= b ? 1 : 0);
        break;
      }
      case Op.GT: {
        const b = this._pop();
        const a = this._pop();
        this._push(a > b ? 1 : 0);
        break;
      }
      case Op.GE: {
        const b = this._pop();
        const a = this._pop();
        this._push(a >= b ? 1 : 0);
        break;
      }
      case Op.NOT:
        this._push(this._pop() ? 0 : 1);
        break;
      case Op.JMP:
        this.pc = u32();
        break;
      case Op.JZ: {
        const target = u32();
        if (this._pop() === 0) this.pc = target;
        break;
      }
      case Op.JNZ: {
        const target = u32();
        if (this._pop() !== 0) this.pc = target;
        break;
      }
      case Op.CALL: {
        const target = u32();
        this.frames.push(this.pc);
        this.pc = target;
        break;
      }
      case Op.RET: {
        if (!this.frames.length) throw new VmError('ret without call', { pc: start });
        this.pc = this.frames.pop();
        break;
      }
      case Op.LOAD: {
        const index = u32();
        this._push(this.locals?.[index] ?? 0);
        break;
      }
      case Op.STORE: {
        const index = u32();
        this.locals = this.locals ?? [];
        this.locals[index] = this._pop();
        break;
      }
      case Op.MLOAD: {
        const handleIndex = u16();
        const length = u32();
        const handle = this._resolveMemory(handleIndex);
        handle.require(Right.READ, `MLOAD on ${handle.name}`);
        const region = handle.target;
        const data = region.read(0, Math.min(length, region.size));
        this._push({ tag: Tag.Bytes, value: Array.from(data) });
        break;
      }
      case Op.MSTORE: {
        const handleIndex = u16();
        const length = u32();
        const handle = this._resolveMemory(handleIndex);
        handle.require(Right.WRITE, `MSTORE on ${handle.name}`);
        const top = this._pop();
        const data = top?.tag === Tag.Bytes ? Uint8Array.from(top.value) : Uint8Array.from([Number(top) & 0xff]);
        handle.target.write(0, data.slice(0, length));
        this._push(data.length);
        break;
      }
      case Op.CALLH: {
        const handleIndex = u16();
        const argc = u8();
        const handle = this._resolveMemory(handleIndex);
        handle.require(Right.EXEC, `CALLH on ${handle.name}`);
        const args = [];
        for (let i = 0; i < argc; i++) args.unshift(this._pop());
        const result = handle.target(...args);
        if (result !== undefined) this._push(result);
        break;
      }
      case Op.EMIT: {
        const handleIndex = u16();
        const handle = this._resolveMemory(handleIndex);
        handle.require(Right.WRITE, `EMIT on ${handle.name}`);
        const payload = this._pop();
        this.output.push(payload);
        if (typeof handle.target?.emit === 'function') handle.target.emit(payload);
        break;
      }
      case Op.HALT:
        this.halted = true;
        break;
      default:
        throw new VmError(`illegal opcode 0x${op.toString(16)}`, { pc: start });
    }

    if (this.emitTrace) {
      this.trace.push({ pc: start, op, stack: [...this.stack] });
    }
  }

  /** Static disassembly of the bound image (useful for the console UI). */
  listing() {
    return disassemble(this.bytes);
  }
}
