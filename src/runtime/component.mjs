import { Context } from '../runtime/context.mjs';
import { CapabilityHandle } from '../runtime/capability.mjs';
import { Tag, Right } from '../runtime/constants.mjs';
import { B8GError } from '../runtime/errors.mjs';

let componentCounter = 0;

/**
 * A component is the unit of composition in b8g.
 *
 * Components never import each other. They declare the capabilities they need
 * in a manifest, receive handles when those capabilities are granted, and
 * communicate exclusively through those handles (see `receive`).
 *
 * The `factory` receives a single argument: the component's *handle bag* — a
 * map from capability name to a {@link CapabilityHandle}. Whatever the factory
 * returns is the component's public export surface.
 */
export class Component {
  /**
   * @param {object} spec
   * @param {string} spec.name
   * @param {string[]} [spec.requires] capability names this component wants
   * @param {string[]} [spec.provides] capability names this component exports
   * @param {(handles: Record<string, CapabilityHandle>, api: object) => any} spec.factory
   */
  constructor(spec) {
    if (!spec?.name) throw new B8GError('component requires a name', 'BAD_COMPONENT');
    if (typeof spec.factory !== 'function') {
      throw new B8GError(`component ${spec.name} requires a factory`, 'BAD_COMPONENT');
    }
    this.id = `cmp-${(++componentCounter).toString(36)}`;
    this.name = spec.name;
    this.version = spec.version ?? '0.0.0';
    this.requires = spec.requires ?? [];
    this.provides = spec.provides ?? [];
    this.factory = spec.factory;
    this.context = new Context(`component:${this.name}`);
    /** @type {Record<string, CapabilityHandle>} */
    this.handles = {};
    this.exports = null;
    this.status = 'declared';
    this.logs = [];
    this.createdAt = Date.now();
  }

  log(message, level = 'info') {
    const entry = { at: Date.now(), level, message };
    this.logs.push(entry);
    return entry;
  }

  /**
   * Grant a capability to this component. The handle is installed into the
   * component's context (its private table) and recorded under a name.
   */
  give(name, handle) {
    this.context.install(handle);
    this.handles[name] = handle;
    this.log(`granted capability "${name}" (${handle.describe().rightsText})`);
    return handle;
  }

  /** Instantiate the component: run its factory with the granted handles. */
  start(api = {}) {
    if (this.status === 'running') return this.exports;
    const missing = this.requires.filter((name) => !this.handles[name]);
    if (missing.length) {
      throw new B8GError(
        `component ${this.name} is missing capabilities: ${missing.join(', ')}`,
        'MISSING_CAPABILITY',
        { missing },
      );
    }
    this.exports = this.factory(this.handles, { ...api, context: this.context }) ?? {};
    this.status = 'running';
    this.log('started');
    return this.exports;
  }

  /** Deliver a message to the component through one of its handles. */
  receive(name, payload) {
    const handle = this.handles[name];
    if (!handle) throw new B8GError(`no capability "${name}" on ${this.name}`, 'NO_CAPABILITY');
    if (typeof handle.target === 'function') {
      handle.require(Right.EXEC, `receive(${name})`);
      return handle.target(payload);
    }
    if (handle.tag === Tag.Memory) {
      handle.require(Right.WRITE, `receive(${name})`);
      const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
      return handle.target.write(0, bytes);
    }
    throw new B8GError(`capability "${name}" is not callable`, 'NOT_CALLABLE');
  }

  /** Serialise the component's capability surface and state summary. */
  snapshot() {
    return {
      id: this.id,
      name: this.name,
      version: this.version,
      status: this.status,
      requires: this.requires,
      provides: this.provides,
      handles: Object.fromEntries(
        Object.entries(this.handles).map(([name, h]) => [name, h.describe()]),
      ),
      logs: this.logs,
    };
  }

  stop() {
    this.status = 'stopped';
    this.context.close();
    this.log('stopped');
  }
}
