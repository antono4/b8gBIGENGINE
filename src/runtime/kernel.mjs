import { MemoryPool } from './memory.mjs';
import { CapabilityHandle } from './capability.mjs';
import { Tag, Right } from './constants.mjs';
import { Context } from './context.mjs';
import { Component } from './component.mjs';
import { Stream, readStreamHandle, writeStreamHandle } from './stream.mjs';
import { B8GError } from './errors.mjs';
import * as snapshotApi from './snapshot.mjs';
import { Vm } from './vm.mjs';

let taskCounter = 0;

/**
 * A task is a unit of deferred work scheduled by the kernel.
 * It is the b8g "Tasks" primitive: a plain thunk plus a lifecycle record.
 */
export class Task {
  constructor(name, fn, opts = {}) {
    this.id = `task-${(++taskCounter).toString(36)}`;
    this.name = name;
    this.fn = fn;
    this.status = 'pending';
    this.result = undefined;
    this.error = null;
    this.durationMs = 0;
    this.scheduledAt = Date.now();
    this.priority = opts.priority ?? 0;
  }

  run() {
    this.status = 'running';
    const start = Date.now();
    try {
      this.result = this.fn();
      this.status = 'done';
      return this.result;
    } catch (err) {
      this.error = err;
      this.status = 'failed';
      throw err;
    } finally {
      this.durationMs = Date.now() - start;
    }
  }

  describe() {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      durationMs: this.durationMs,
      error: this.error ? String(this.error.message ?? this.error) : null,
    };
  }
}

/**
 * The kernel is the "host component" described in the b8g README.
 *
 * It owns the shared-memory pool, the registry of contexts/components/streams
 * and the task scheduler, and it exposes `run` and `watch` — the two verbs a
 * b8g engine is built from. A second kernel can be composited with a compiler
 * component to produce an engine that can compile itself.
 */
export class Kernel {
  constructor(opts = {}) {
    this.name = opts.name ?? 'b8g-kernel';
    this.pool = new MemoryPool();
    /** @type {Map<string, Component>} */
    this.components = new Map();
    /** @type {Map<string, Stream>} */
    this.streams = new Map();
    /** @type {Map<string, Context>} */
    this.contexts = new Map();
    /** @type {Task[]} */
    this.tasks = [];
    this.root = new Context('root');
    this.contexts.set(this.root.id, this.root);
    this.watchers = new Set();
    this.events = [];
    this.createdAt = Date.now();
    this.clock = 0;
  }

  /** Emit a kernel-level event and fan it out to watchers. */
  emit(type, detail = {}) {
    const event = { at: Date.now(), clock: this.clock++, type, detail };
    this.events.push(event);
    if (this.events.length > 4096) this.events.shift();
    for (const watcher of this.watchers) {
      try {
        watcher(event);
      } catch {
        /* watchers are isolated from the kernel */
      }
    }
    return event;
  }

  /** The `watch` verb: observe kernel events. Returns an unsubscribe fn. */
  watch(fn) {
    this.watchers.add(fn);
    return () => this.watchers.delete(fn);
  }

  /** Create a shared or private memory region and a full-rights handle. */
  alloc(size, opts = {}) {
    const region = this.pool.create(size, opts);
    const handle = new CapabilityHandle(Tag.Memory, region, Right.READ | Right.WRITE | Right.TRANSFER | Right.GRANT, {
      name: opts.name ?? region.name,
      owner: 'kernel',
    });
    this.root.install(handle);
    this.emit('memory:alloc', { region: region.describe(), handle: handle.id });
    return { region, handle };
  }

  /** Create a named stream and its read/write handles. */
  openStream(name, opts = {}) {
    const stream = new Stream(name, opts);
    this.streams.set(name, stream);
    const handle = writeStreamHandle(stream, 'kernel');
    this.root.install(handle);
    this.emit('stream:open', { stream: stream.describe() });
    return { stream, handle, readHandle: readStreamHandle(stream) };
  }

  /** Register a component (declaration only; nothing runs yet). */
  register(spec) {
    const component = new Component(spec);
    this.components.set(component.name, component);
    this.contexts.set(component.context.id, component.context);
    this.emit('component:register', { component: component.name });
    return component;
  }

  /** Grant a kernel handle to a component by handle id or object. */
  grant(componentName, capabilityName, handleOrId, rights) {
    const component = this.components.get(componentName);
    if (!component) throw new B8GError(`unknown component ${componentName}`, 'NO_COMPONENT');
    const handle = typeof handleOrId === 'string' ? this.root.lookup(handleOrId) : handleOrId;
    const granted = rights === undefined ? handle : handle.derive(rights, { owner: component.name });
    component.give(capabilityName, granted);
    this.emit('capability:grant', {
      component: component.name,
      capability: capabilityName,
      rights: granted.describe().rightsText,
    });
    return granted;
  }

  /** The `run` verb: start a component (or all of them) in dependency order. */
  run(name) {
    if (name) {
      const component = this.components.get(name);
      if (!component) throw new B8GError(`unknown component ${name}`, 'NO_COMPONENT');
      const exports = component.start(this.api());
      this.emit('component:run', { component: name });
      return exports;
    }
    for (const component of this.components.values()) {
      component.start(this.api());
      this.emit('component:run', { component: component.name });
    }
    return this;
  }

  /** Schedule a task on the kernel's task queue. */
  schedule(name, fn, opts = {}) {
    const task = new Task(name, fn, opts);
    this.tasks.push(task);
    this.emit('task:schedule', { task: task.id, name });
    return task;
  }

  /** Run every pending task in priority order (highest first). */
  drain() {
    const pending = this.tasks.filter((t) => t.status === 'pending').sort((a, b) => b.priority - a.priority);
    const results = [];
    for (const task of pending) {
      try {
        results.push({ task: task.describe(), result: task.run() });
        this.emit('task:done', task.describe());
      } catch (err) {
        this.emit('task:failed', task.describe());
        throw err;
      }
    }
    return results;
  }

  /** A minimal API surface handed to components (no shared state, only calls). */
  api() {
    return {
      alloc: (size, opts) => this.alloc(size, opts),
      openStream: (name, opts) => this.openStream(name, opts),
      schedule: (name, fn, opts) => this.schedule(name, fn, opts),
      emit: (type, detail) => this.emit(type, detail),
      log: (msg) => this.emit('log', { msg }),
      snapshot: snapshotApi,
      vm: { Vm },
    };
  }

  describe() {
    return {
      name: this.name,
      uptimeMs: Date.now() - this.createdAt,
      clock: this.clock,
      memory: { bytesAllocated: this.pool.bytesAllocated, regions: this.pool.list() },
      components: [...this.components.values()].map((c) => c.snapshot()),
      streams: [...this.streams.values()].map((s) => s.describe()),
      tasks: this.tasks.map((t) => t.describe()),
      events: this.events.slice(-100),
    };
  }
}
