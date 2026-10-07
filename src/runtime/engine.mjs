import { Kernel } from './kernel.mjs';
import { Tag, Right } from './constants.mjs';
import { CapabilityHandle } from './capability.mjs';
import { MemoryRegion } from './memory.mjs';
import { readStreamHandle, writeStreamHandle } from './stream.mjs';
import { assemble, disassemble } from './isa.mjs';
import { Vm } from './vm.mjs';
import { MultiPassCompiler } from '../compiler/index.mjs';
import { auditComponent, functionHandle } from '../components/audit.mjs';
import { snapshotComponent, memoryHandle } from '../components/snapshot.mjs';
import { runnerComponent } from '../components/runner.mjs';
import { serializeSnapshot, deserializeSnapshot, inspectSnapshot } from './snapshot.mjs';
import { B8GError } from './errors.mjs';

/**
 * The b8g engine.
 *
 * Composition per the README: a host {@link Kernel} (run + watch) is composited
 * with a compiler (the {@link MultiPassCompiler}) and a set of capability
 * components to produce an engine that can compile, audit, snapshot and run
 * code — including, in principle, itself.
 *
 * The engine exposes a single high-level API used by both the CLI and the HTTP
 * server, so the two front-ends can never drift apart.
 */
export class Engine {
  constructor(opts = {}) {
    this.kernel = new Kernel({ name: opts.name ?? 'b8g' });
    this.compiler = opts.compiler ?? MultiPassCompiler.standard();
    this.components = {};
    this.streams = {};
    this._booted = false;
    this.bootLog = [];
  }

  /** Build the default engine: kernel + compiler + reference components. */
  static boot(opts = {}) {
    const engine = new Engine(opts);
    engine.boot();
    return engine;
  }

  boot() {
    if (this._booted) return this;
    const kernel = this.kernel;

    // Streams: audit reports, VM results, kernel log.
    this.streams.audit = kernel.openStream('audit');
    this.streams.results = kernel.openStream('results');
    this.streams.log = kernel.openStream('log');

    // Shared regions used as capability transports.
    const { region: heapRegion, handle: heapHandle } = kernel.alloc(64 * 1024, { name: 'audit-heap', shared: true });
    const { region: storeRegion, handle: storeHandle } = kernel.alloc(1024 * 1024, { name: 'snapshot-store', shared: true });
    const { region: vmHeapRegion, handle: vmHeapHandle } = kernel.alloc(64 * 1024, { name: 'vm-heap', shared: true });
    this.regions = { heap: heapRegion, store: storeRegion, vmHeap: vmHeapRegion };

    // Register the reference components.
    this.components.audit = kernel.register(auditComponent);
    this.components.snapshot = kernel.register(snapshotComponent);
    this.components.runner = kernel.register(runnerComponent);

    // Grant capabilities — the only bridge into each component's context.
    kernel.grant('audit', 'heap', heapHandle, Right.READ | Right.WRITE);
    kernel.grant('audit', 'report', writeStreamHandle(this.streams.audit.stream, 'audit'));

    kernel.grant('snapshot', 'store', storeHandle, Right.READ | Right.WRITE);
    kernel.grant('snapshot', 'log', writeStreamHandle(this.streams.log.stream, 'snapshot'));

    kernel.grant('runner', 'vm-heap', vmHeapHandle, Right.READ | Right.WRITE);
    kernel.grant('runner', 'results', writeStreamHandle(this.streams.results.stream, 'runner'));

    // Run them.
    kernel.run();

    this._booted = true;
    this.bootLog.push(`booted ${Object.keys(this.components).length} components`);
    return this;
  }

  /** Compile a unit through the universal compiler feedback interface. */
  compile({ name = 'unit', language = 'ecmascript', source, adapters }) {
    const report = this.compiler.compile({ name, language, source, adapters });
    this.kernel.emit('compile', { unit: name, language, ok: report.ok, summary: report.summary });
    return report;
  }

  /** Audit a unit for runtime hazards; returns the component's record. */
  audit({ name = 'unit', language = 'ecmascript', source }) {
    const audit = this.components.audit.exports;
    const record = audit.scan({ name, language, source });
    this.kernel.emit('audit', { unit: name, riskScore: record.riskScore });
    return record;
  }

  /** Assemble a stack program, returning the binary image and its listing. */
  assemble(program) {
    const { bytes, instructions, labels } = assemble(program);
    return { bytes, instructions, labels: Object.fromEntries(labels) };
  }

  /** Execute a binary stack image inside the runner component. */
  execute({ name = 'program', bytes, trace = false, limits }) {
    const runner = this.components.runner.exports;
    return runner.execute({ name, bytes, trace, limits });
  }

  /** Capture the whole engine state into a snapshot blob. */
  snapshot(name = 'b8g-engine') {
    const state = this.state();
    const bytes = serializeSnapshot(state, name);
    const blob = new Uint8Array(bytes);
    // Also stage the blob in the snapshot-store region via the component.
    this.components.snapshot.exports.capture(
      { ...state, blobs: [] },
      name,
    );
    return { name, size: blob.length, bytes: blob, header: inspectSnapshot(blob) };
  }

  /** Reconstruct a snapshot from a blob. */
  restore(bytes) {
    return deserializeSnapshot(bytes);
  }

  /** The engine's serialisable state (the input to a snapshot). */
  state() {
    const kernel = this.kernel;
    return {
      rehashable: true,
      meta: {
        engine: kernel.name,
        bootedAt: kernel.createdAt,
        components: Object.keys(this.components),
        compilerAdapters: this.compiler.list().map((c) => c.name),
      },
      readonly: { version: '0.1.0', isa: 'b8g-stack-v1' },
      memory: { bytesAllocated: kernel.pool.bytesAllocated, regions: kernel.pool.list() },
      contexts: [kernel.root, ...Object.values(this.components).map((c) => c.context)].map((c) => c.describe()),
      capabilities: kernel.root.handleList().map((h) => h.describe()),
      components: Object.values(this.components).map((c) => c.snapshot()),
      streams: Object.values(this.streams).map((s) => s.stream.describe()),
      blobs: [
        { id: 'audit-heap', bytes: this.regions.heap.read(0, this.regions.heap.size) },
        { id: 'vm-heap', bytes: this.regions.vmHeap.read(0, this.regions.vmHeap.size) },
      ],
    };
  }

  /** Attach a listener to the kernel event bus (the `watch` verb). */
  watch(fn) {
    return this.kernel.watch(fn);
  }

  status() {
    return this.kernel.describe();
  }
}

export { Tag, Right, CapabilityHandle, MemoryRegion, readStreamHandle, writeStreamHandle, functionHandle, memoryHandle, Vm, assemble, disassemble, B8GError };
