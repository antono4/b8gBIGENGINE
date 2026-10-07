import { B8GError } from './errors.mjs';

let regionCounter = 0;

/**
 * A memory region is the single transport primitive of b8g.
 *
 * Components never share state directly: they receive a *handle* to a region
 * and read/write offset-addressed bytes through it. A region may be shared
 * (visible to every holder of a handle) or private (visible only to the
 * context that created it).
 */
export class MemoryRegion {
  /**
   * @param {number} size bytes to allocate
   * @param {{shared?: boolean, name?: string}} [opts]
   */
  constructor(size = 4096, opts = {}) {
    if (!Number.isInteger(size) || size <= 0) {
      throw new B8GError(`invalid region size: ${size}`, 'BAD_REGION_SIZE');
    }
    this.id = `mem-${(++regionCounter).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.size = size;
    this.shared = opts.shared ?? true;
    this.name = opts.name ?? this.id;
    // SharedArrayBuffer requires cross-origin isolation in most browsers, which
    // a static host cannot provide. Fall back to a private buffer there: the
    // region API is identical, only cross-realm sharing is lost.
    const BufferType = this.shared && typeof SharedArrayBuffer !== 'undefined' ? SharedArrayBuffer : ArrayBuffer;
    /** @type {SharedArrayBuffer|ArrayBuffer} */
    this.buffer = new BufferType(size);
    this.createdAt = Date.now();
    this.reads = 0;
    this.writes = 0;
  }

  get view() {
    return new Uint8Array(this.buffer);
  }

  _assertRange(offset, length) {
    if (!Number.isInteger(offset) || offset < 0 || offset + length > this.size) {
      throw new B8GError(
        `out of bounds access: offset=${offset} length=${length} size=${this.size}`,
        'OUT_OF_BOUNDS',
        { offset, length, size: this.size },
      );
    }
  }

  read(offset, length) {
    this._assertRange(offset, length);
    this.reads++;
    return new Uint8Array(this.buffer, offset, length).slice();
  }

  write(offset, bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this._assertRange(offset, data.length);
    this.writes++;
    new Uint8Array(this.buffer, offset, data.length).set(data);
    return data.length;
  }

  fill(value, offset = 0, length = this.size - offset) {
    this._assertRange(offset, length);
    this.writes++;
    new Uint8Array(this.buffer, offset, length).fill(value & 0xff);
  }

  /** A cheap structural description, safe to serialise into a snapshot header. */
  describe() {
    return {
      id: this.id,
      name: this.name,
      size: this.size,
      shared: this.shared,
      reads: this.reads,
      writes: this.writes,
    };
  }
}

/** A pool that owns every region created inside one engine instance. */
export class MemoryPool {
  constructor() {
    /** @type {Map<string, MemoryRegion>} */
    this.regions = new Map();
    this.bytesAllocated = 0;
  }

  create(size, opts = {}) {
    const region = new MemoryRegion(size, opts);
    this.regions.set(region.id, region);
    this.bytesAllocated += region.size;
    return region;
  }

  get(id) {
    return this.regions.get(id);
  }

  release(id) {
    const region = this.regions.get(id);
    if (region) {
      this.bytesAllocated -= region.size;
      this.regions.delete(id);
    }
    return !!region;
  }

  list() {
    return [...this.regions.values()].map((r) => r.describe());
  }
}
