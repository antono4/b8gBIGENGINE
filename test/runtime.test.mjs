import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assemble, disassemble } from '../src/runtime/isa.mjs';
import { Vm } from '../src/runtime/vm.mjs';
import { Context } from '../src/runtime/context.mjs';
import { CapabilityHandle } from '../src/runtime/capability.mjs';
import { Tag, Right } from '../src/runtime/constants.mjs';
import { MemoryPool } from '../src/runtime/memory.mjs';
import { CapabilityError, VmError } from '../src/runtime/errors.mjs';

test('assembler round-trips through the disassembler', () => {
  const program = [
    ['PUSH', 6],
    ['PUSH', 7],
    ['MUL'],
    ['PUSH', 2],
    ['ADD'],
    ['HALT'],
  ];
  const { bytes, instructions } = assemble(program);
  assert.equal(bytes.length, 30);
  assert.equal(instructions.length, 6);

  const listing = disassemble(bytes);
  assert.deepEqual(
    listing.map((i) => i.name),
    ['PUSH', 'PUSH', 'MUL', 'PUSH', 'ADD', 'HALT'],
  );
  assert.deepEqual(listing[0].operands, [6]);
});

test('labels resolve to absolute program counters', () => {
  const program = [['PUSH', 1], ['JZ', 'end'], ['PUSH', 2], 'end:', ['HALT']];
  const { instructions, labels } = assemble(program);
  const jz = instructions.find((i) => i.name === 'JZ');
  assert.equal(jz.operands[0], labels.get('end'));
  assert.equal(labels.get('end'), 23);
  assert.deepEqual(
    instructions.map((i) => i.name),
    ['PUSH', 'JZ', 'PUSH', 'HALT'],
  );
  assert.equal(instructions[1].pc, 9);
});

test('vm executes arithmetic to a single result', () => {
  const { bytes } = assemble([['PUSH', 6], ['PUSH', 7], ['MUL'], ['PUSH', 2], ['ADD'], ['HALT']]);
  const vm = new Vm({ bytes });
  const outcome = vm.run();
  assert.equal(outcome.reason, 'halt');
  assert.deepEqual(vm.stack, [44]);
});

test('vm runs a labelled loop and terminates', () => {
  const program = [
    ['PUSH', 5],
    ['STORE', 0],
    'loop:',
    ['LOAD', 0],
    ['JZ', 'done'],
    ['LOAD', 0],
    ['PUSH', 1],
    ['SUB'],
    ['STORE', 0],
    ['JMP', 'loop'],
    'done:',
    ['LOAD', 0],
    ['HALT'],
  ];
  const { bytes } = assemble(program);
  const vm = new Vm({ bytes });
  vm.run();
  assert.deepEqual(vm.stack, [0]);
});

test('vm enforces a step limit', () => {
  const { bytes } = assemble(['spin:', ['JMP', 'spin']]);
  const vm = new Vm({ bytes, limits: { steps: 1000 } });
  assert.throws(() => vm.run(), (err) => err instanceof VmError && err.code === 'VM_ERROR');
});

test('division by zero is a vm error, not a crash', () => {
  const { bytes } = assemble([['PUSH', 1], ['PUSH', 0], ['DIV'], ['HALT']]);
  const vm = new Vm({ bytes });
  assert.throws(() => vm.run(), /division by zero/);
});

test('memory regions reject out-of-bounds access', () => {
  const pool = new MemoryPool();
  const region = pool.create(16, { name: 'test' });
  region.write(0, new Uint8Array([1, 2, 3]));
  assert.deepEqual([...region.read(0, 3)], [1, 2, 3]);
  assert.throws(() => region.read(14, 8), /out of bounds/);
});

test('capability rights cannot be amplified by derivation', () => {
  const handle = new CapabilityHandle(Tag.Memory, {}, Right.READ, { name: 'readonly' });
  const narrowed = handle.derive(Right.READ);
  assert.equal(narrowed.rights, Right.READ);
  assert.throws(() => handle.derive(Right.READ | Right.WRITE), CapabilityError);
});

test('capability require() throws when a right is missing', () => {
  const handle = new CapabilityHandle(Tag.Memory, {}, Right.READ, { name: 'readonly' });
  assert.equal(handle.require(Right.READ, 'read'), handle);
  assert.throws(() => handle.require(Right.WRITE, 'write'), CapabilityError);
});

test('contexts only share state through an explicit grant', () => {
  const pool = new MemoryPool();
  const region = pool.create(32, { name: 'shared' });
  const a = new Context('a');
  const b = new Context('b');
  const handle = new CapabilityHandle(Tag.Memory, region, Right.READ | Right.WRITE | Right.GRANT, { name: 'shared' });
  a.install(handle);

  // b cannot see it yet.
  assert.throws(() => b.lookup(handle.id), CapabilityError);

  a.grant(handle.id, b);
  assert.equal(b.lookup(handle.id).id, handle.id);
  assert.equal(a.notes.at(-1).event, 'grant');
});

test('granting without GRANT right is denied', () => {
  const a = new Context('a');
  const b = new Context('b');
  const handle = new CapabilityHandle(Tag.Memory, {}, Right.READ, { name: 'sealed' });
  a.install(handle);
  assert.throws(() => a.grant(handle.id, b), CapabilityError);
});

test('vm can call a function handle with EXEC right only', () => {
  const ctx = new Context('runner');
  let received = null;
  const fn = (x) => {
    received = x;
    return x * 2;
  };
  ctx.install(new CapabilityHandle(Tag.Function, fn, Right.EXEC, { name: 'double' }));
  const { bytes } = assemble([['PUSH', 21], ['CALLH', 0, 1], ['HALT']]);
  const vm = new Vm({ bytes, context: ctx });
  vm.run();
  assert.equal(received, 21);
  assert.deepEqual(vm.stack, [42]);
});
