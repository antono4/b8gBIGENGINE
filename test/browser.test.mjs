import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootBrowserEngine } from '../src/browser.mjs';
import { MemoryRegion } from '../src/runtime/memory.mjs';

test('in-page engine boots with the reference components', () => {
  const b = bootBrowserEngine();
  const status = b.call('GET', '/api/status');
  assert.deepEqual(status.components.map((c) => c.name).sort(), ['audit', 'runner', 'snapshot']);
  assert.equal(status.memory.regions.length, 3);
});

test('in-page engine runs the full pipeline through the shared API table', () => {
  const b = bootBrowserEngine();
  const res = b.call('POST', '/api/pipeline', {
    source: 'function f(){ return 1; }',
    language: 'ecmascript',
    trace: true,
  });
  assert.equal(res.compile.ok, true);
  assert.deepEqual(res.execute.stack, [44]);
  assert.equal(res.snapshot.header.checksumValid, true);
});

test('in-page engine assembles and executes a program without a server', () => {
  const b = bootBrowserEngine();
  const assembled = b.call('POST', '/api/assemble', {
    program: [['PUSH', 6], ['PUSH', 7], ['MUL'], ['HALT']],
  });
  const executed = b.call('POST', '/api/execute', { bytes: assembled.bytes });
  assert.deepEqual(executed.stack, [42]);
});

test('in-page engine exposes runtime capability reporting', () => {
  const b = bootBrowserEngine();
  const rt = b.call('GET', '/api/runtime');
  assert.ok(['node', 'browser'].includes(rt.runtime));
  assert.equal(rt.host, true);
});

test('unknown API route is rejected', () => {
  const b = bootBrowserEngine();
  assert.throws(() => b.call('GET', '/api/does-not-exist'), /no route/);
});

test('memory regions fall back to ArrayBuffer without SharedArrayBuffer', () => {
  const saved = globalThis.SharedArrayBuffer;
  delete globalThis.SharedArrayBuffer;
  try {
    const region = new MemoryRegion(16, { shared: true });
    assert.ok(region.buffer instanceof ArrayBuffer);
    region.write(0, new Uint8Array([1, 2, 3]));
    assert.deepEqual([...region.read(0, 3)], [1, 2, 3]);
  } finally {
    globalThis.SharedArrayBuffer = saved;
  }
});
