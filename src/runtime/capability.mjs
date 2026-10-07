import { Tag, Right, rightsToString } from './constants.mjs';
import { CapabilityError } from './errors.mjs';

let handleCounter = 0;

/**
 * A capability handle is the *only* way a component touches anything outside
 * itself. It couples a target (a memory region, a function, a stream, ...)
 * with a rights mask and a cryptographic secret symbol.
 *
 * The secret symbol is what "links contexts up": two contexts can only
 * recognise the same handle if one explicitly granted it to the other, which
 * is the capability-based security model described in the b8g README.
 */
export class CapabilityHandle {
  /**
   * @param {number} tag one of {@link Tag}
   * @param {*} target the underlying value
   * @param {number} rights bitmask of {@link Right}
   * @param {{name?: string, owner?: string, secret?: symbol}} [opts]
   */
  constructor(tag, target, rights = Right.READ, opts = {}) {
    this.id = `cap-${(++handleCounter).toString(36)}`;
    this.tag = tag;
    this.target = target;
    this.rights = rights;
    this.name = opts.name ?? this.id;
    this.owner = opts.owner ?? 'kernel';
    this.secret = opts.secret ?? Symbol(`cap:${this.id}`);
    this.grants = 0;
    this.createdAt = Date.now();
  }

  has(right) {
    return (this.rights & right) === right;
  }

  /** Returns a *new* handle with a possibly reduced rights mask. */
  derive(rights, opts = {}) {
    const reduced = this.rights & rights;
    if (reduced !== rights) {
      // Derivation may never amplify rights.
      const missing = rights & ~this.rights;
      throw new CapabilityError(
        `cannot derive rights ${rightsToString(missing)} from handle ${this.name}`,
        { handle: this.id, missing: rightsToString(missing) },
      );
    }
    this.grants++;
    return new CapabilityHandle(this.tag, this.target, reduced, {
      name: opts.name ?? this.name,
      owner: opts.owner ?? this.owner,
      secret: opts.secret ?? Symbol(`cap:${this.id}:${this.grants}`),
    });
  }

  /** Assert a right, throwing a capability error if absent. */
  require(right, what = 'operation') {
    if (!this.has(right)) {
      throw new CapabilityError(
        `${what} requires ${rightsToString(right)} on handle ${this.name}`,
        { handle: this.id, held: rightsToString(this.rights) },
      );
    }
    return this;
  }

  describe() {
    return {
      id: this.id,
      name: this.name,
      tag: this.tag,
      tagName: Object.keys(Tag).find((k) => Tag[k] === this.tag),
      rights: this.rights,
      rightsText: rightsToString(this.rights),
      owner: this.owner,
      target: this.tag === Tag.Memory ? this.target?.describe?.() : typeof this.target,
    };
  }
}

export { Tag, Right };
