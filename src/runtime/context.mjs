import { CapabilityError, B8GError } from './errors.mjs';
import { Right } from './constants.mjs';

let contextCounter = 0;

/**
 * A context is an isolated execution container.
 *
 * It owns a table of capability handles and a secret key symbol. Two contexts
 * share no state by default; the only bridge between them is an explicit
 * `grant()` of a handle (the "link them up" mechanism from the b8g README).
 */
export class Context {
  /**
   * @param {string} name
   * @param {{parent?: Context, secret?: symbol}} [opts]
   */
  constructor(name, opts = {}) {
    this.id = `ctx-${(++contextCounter).toString(36)}`;
    this.name = name;
    this.parent = opts.parent ?? null;
    this.secret = opts.secret ?? Symbol(`ctx:${this.id}`);
    /** @type {Map<string, import('./capability.mjs').CapabilityHandle>} */
    this.handles = new Map();
    this.createdAt = Date.now();
    this.alive = true;
    this.notes = [];
  }

  /** Install a handle into this context's capability table. */
  install(handle) {
    if (!handle?.id) throw new B8GError('not a capability handle', 'BAD_HANDLE');
    this.handles.set(handle.id, handle);
    return handle;
  }

  /** Look a handle up by id, enforcing ownership/secret matching. */
  lookup(id) {
    const handle = this.handles.get(id);
    if (!handle) {
      throw new CapabilityError(`context ${this.name} has no handle ${id}`, { context: this.id, handle: id });
    }
    return handle;
  }

  has(id) {
    return this.handles.has(id);
  }

  /** Stable, index-addressable view of the handle table (used by the VM). */
  handleList() {
    return [...this.handles.values()];
  }

  /** Resolve a handle by its table index, as encoded in binary operands. */
  byIndex(index) {
    const handle = this.handleList()[index];
    if (!handle) {
      throw new CapabilityError(`context ${this.name} has no handle at index ${index}`, {
        context: this.id,
        index,
      });
    }
    return handle;
  }

  /**
   * Hand a capability to another context. This is the *only* sanctioned way
   * for state to cross a context boundary, and it is auditable.
   *
   * @param {string} handleId
   * @param {Context} target
   * @param {number} [rights] optionally narrowed rights for the grant
   */
  grant(handleId, target, rights) {
    const handle = this.lookup(handleId);
    handle.require(Right.GRANT, `granting ${handle.name}`);
    const exported = rights === undefined ? handle : handle.derive(rights, { owner: target.name });
    target.install(exported);
    this.notes.push({ at: Date.now(), event: 'grant', handle: handle.id, to: target.id });
    return exported;
  }

  /** Revoke a handle from this context. */
  revoke(handleId) {
    return this.handles.delete(handleId);
  }

  close() {
    this.alive = false;
    this.handles.clear();
  }

  describe() {
    return {
      id: this.id,
      name: this.name,
      parent: this.parent?.id ?? null,
      alive: this.alive,
      handles: [...this.handles.values()].map((h) => h.describe()),
      notes: this.notes,
    };
  }
}
