/** Error hierarchy used across the engine. */
export class B8GError extends Error {
  constructor(message, code = 'B8G_ERROR', details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

export class CapabilityError extends B8GError {
  constructor(message, details) {
    super(message, 'CAPABILITY_DENIED', details);
  }
}

export class CompileError extends B8GError {
  constructor(message, details) {
    super(message, 'COMPILE_ERROR', details);
  }
}

export class SnapshotError extends B8GError {
  constructor(message, details) {
    super(message, 'SNAPSHOT_ERROR', details);
  }
}

export class VmError extends B8GError {
  constructor(message, details) {
    super(message, 'VM_ERROR', details);
  }
}
