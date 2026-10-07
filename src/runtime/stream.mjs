import { Tag, Right } from './constants.mjs';
import { CapabilityHandle } from './capability.mjs';

/**
 * A stream is a hosted, capability-guarded event channel.
 *
 * It implements the "Streams / Events" primitive of b8g on top of the handle
 * model: writing to the stream (EMIT) and subscribing to it are both gated by
 * rights on the handle that carries it.
 */
export class Stream {
  constructor(name = 'stream', { capacity = 1024 } = {}) {
    this.id = `stream-${Math.random().toString(36).slice(2, 8)}`;
    this.name = name;
    this.capacity = capacity;
    this.buffer = [];
    this.listeners = new Set();
    this.total = 0;
    this.createdAt = Date.now();
  }

  emit(payload) {
    this.total++;
    this.buffer.push({ at: Date.now(), payload });
    if (this.buffer.length > this.capacity) this.buffer.shift();
    for (const listener of this.listeners) {
      try {
        listener(payload);
      } catch {
        // A misbehaving subscriber must never break the emitting component.
      }
    }
    return this.total;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  read(from = 0) {
    return this.buffer.slice(from);
  }

  describe() {
    return {
      id: this.id,
      name: this.name,
      total: this.total,
      buffered: this.buffer.length,
      listeners: this.listeners.size,
    };
  }
}

/** Build a read-only handle to a stream (subscription / observation). */
export function readStreamHandle(stream, owner = 'kernel') {
  return new CapabilityHandle(Tag.Stream, stream, Right.READ, { name: stream.name, owner });
}

/** Build a writable handle to a stream (emission). */
export function writeStreamHandle(stream, owner = 'kernel') {
  return new CapabilityHandle(Tag.Stream, stream, Right.READ | Right.WRITE, { name: stream.name, owner });
}
