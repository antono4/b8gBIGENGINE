import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  serializeSnapshot,
  deserializeSnapshot,
  inspectSnapshot,
  fnv1a32,
} from '../src/runtime/snapshot.mjs';
import { Engine } from '../src/runtime/engine.mjs';

test('fnv1a32 is deterministic and order-sensitive', () => {
  const a = fnv1a32(new Uint8Array([1, 2, 3]));
  assert.equal(a, fnv1a32(new Uint8Array([1, 2, 3])));
  assert.notEqual(a, fnv1a32(new Uint8Array([3, 2, 1])));
});

test('snapshot header carries magic, version and a valid checksum', () => {
  const state = {
    contexts: [{ id: 'ctx-1', name: 'root' }],
    components: [],
    memory: { bytesAllocated: 0, regions: [] },
    blobs: [{ id: 'blob-1', bytes: new Uint8Array([9, 9, 9]) }],
  };
  const bytes = serializeSnapshot(state, 'unit-test');
  const header = inspectSnapshot(bytes);

  assert.equal(header.magic, '0x42384730');
  assert.equal(header.version, 1);
  assert.equal(header.rehashable, true);
  assert.equal(header.contextCount, 1);
  assert.equal(header.name, 'unit-test');
  assert.equal(header.checksumValid, true);
  assert.ok(header.payloadLength > 0);
});

test('snapshot round-trips sections and raw blob bytes', () => {
  const blob = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const state = {
    rehashable: true,
    readonly: { version: '0.1.0' },
    contexts: [{ id: 'ctx-1', name: 'root' }],
    capabilities: [{ id: 'cap-1', name: 'heap', rightsText: 'read|write' }],
    components: [{ name: 'audit', version: '0.1.0' }],
    streams: [{ name: 'audit' }],
    meta: { engine: 'b8g' },
    blobs: [{ id: 'region-1', bytes: blob }],
  };
  const bytes = serializeSnapshot(state, 'roundtrip');
  const decoded = deserializeSnapshot(bytes);

  assert.equal(decoded.checksumValid, true);
  assert.equal(decoded.contexts.length, 1);
  assert.equal(decoded.components[0].name, 'audit');
  assert.equal(decoded.capabilities[0].rightsText, 'read|write');
  assert.equal(decoded.meta.engine, 'b8g');
  assert.deepEqual([...decoded.blobs[0].bytes], [...blob]);
});

test('corrupting the payload invalidates the checksum', () => {
  const bytes = serializeSnapshot(
    { contexts: [{ id: 'c' }], meta: { note: 'x'.repeat(400) }, blobs: [] },
    'corrupt',
  );
  const tampered = Uint8Array.from(bytes);
  // Offset 150 is inside the payload (header is 128 bytes), not the trailer.
  tampered[150] = tampered[150] ^ 0xff;
  assert.equal(inspectSnapshot(tampered).checksumValid, false);
});

test('deserialising a non-snapshot throws', () => {
  assert.throws(() => deserializeSnapshot(new Uint8Array(200)), /bad magic/);
});

test('engine boots, snapshots and restores its own state', () => {
  const engine = Engine.boot();
  const snap = engine.snapshot('engine-test');
  assert.ok(snap.size > 128);
  assert.equal(snap.header.checksumValid, true);

  const restored = engine.restore(snap.bytes);
  assert.equal(restored.name, 'engine-test');
  assert.equal(restored.components.length, 3);
  assert.equal(restored.contexts.length, 4); // root + audit + snapshot + runner
});

test('engine compiles and audits a unit end to end', () => {
  const engine = Engine.boot();
  const source = 'function f(a){ return a + 1; } const dead = 1; f(1);';

  const report = engine.compile({ name: 'u', language: 'ecmascript', source });
  assert.ok(report.pipeline.includes('v8'));
  assert.ok(report.artifacts.length > 0);

  const audit = engine.audit({ name: 'u', language: 'ecmascript', source });
  assert.equal(audit.unit, 'u');
  assert.ok(Array.isArray(audit.findings));
});

test('engine executes a stack program inside the runner component', () => {
  const engine = Engine.boot();
  const { bytes } = engine.assemble([['PUSH', 6], ['PUSH', 7], ['MUL'], ['PUSH', 2], ['ADD'], ['HALT']]);
  const result = engine.execute({ name: 'calc', bytes });
  assert.equal(result.reason, 'halt');
  assert.deepEqual(result.stack, [44]);
});

test('engine emits kernel events while composing components', () => {
  const engine = Engine.boot();
  const types = engine.status().events.map((e) => e.type);
  assert.ok(types.includes('memory:alloc'));
  assert.ok(types.includes('capability:grant'));
  assert.ok(types.includes('component:run'));
});
