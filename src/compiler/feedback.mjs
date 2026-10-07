import { B8GError } from '../runtime/errors.mjs';

/**
 * Universal Compiler Feedback Interface.
 *
 * A compiler adapter takes a *unit* (source bytes + a language hint) and
 * returns a normalised {@link Feedback} object: diagnostics, optimisation
 * remarks, produced artifacts and a timing breakdown. Every toolchain —
 * LLVM, GCC, V8, GraalVM — is reduced to this one shape, which is what lets a
 * b8g engine swap compilers without changing any downstream component.
 */

export const Severity = Object.freeze({
  NOTE: 'note',
  REMARK: 'remark',
  WARNING: 'warning',
  ERROR: 'error',
  FATAL: 'fatal',
});

/** A single normalised diagnostic. */
export class Diagnostic {
  constructor({ severity = Severity.NOTE, message, line = 0, column = 0, file = '<input>', pass = null, hint = null }) {
    this.severity = severity;
    this.message = message;
    this.line = line;
    this.column = column;
    this.file = file;
    this.pass = pass;
    this.hint = hint;
  }
  toJSON() {
    return { ...this };
  }
}

/** An optimisation remark (the "feedback" a b8g engine feeds back to AI/codegen). */
export class Remark {
  constructor({ pass, message, impact = 0, suggestion = null }) {
    this.pass = pass;
    this.message = message;
    this.impact = impact;
    this.suggestion = suggestion;
  }
  toJSON() {
    return { ...this };
  }
}

/** The result of compiling one unit through an adapter. */
export class Feedback {
  constructor(adapter, unit, { diagnostics = [], remarks = [], artifacts = [], timings = {} } = {}) {
    this.adapter = adapter;
    this.unit = unit;
    this.diagnostics = diagnostics;
    this.remarks = remarks;
    this.artifacts = artifacts;
    this.timings = timings;
    this.startedAt = Date.now();
  }

  get ok() {
    return !this.diagnostics.some((d) => d.severity === Severity.ERROR || d.severity === Severity.FATAL);
  }

  get errorCount() {
    return this.diagnostics.filter((d) => d.severity === Severity.ERROR || d.severity === Severity.FATAL).length;
  }

  get warningCount() {
    return this.diagnostics.filter((d) => d.severity === Severity.WARNING).length;
  }

  /** Machine-readable feedback payload handed back to callers/AI tooling. */
  toJSON() {
    return {
      adapter: this.adapter,
      unit: { name: this.unit.name, language: this.unit.language, size: this.unit.source.length },
      ok: this.ok,
      errorCount: this.errorCount,
      warningCount: this.warningCount,
      diagnostics: this.diagnostics.map((d) => d.toJSON()),
      remarks: this.remarks.map((r) => r.toJSON()),
      artifacts: this.artifacts.map((a) => ({ name: a.name, kind: a.kind, size: a.bytes.length })),
      timings: this.timings,
    };
  }
}

/**
 * Base class for compiler adapters. Subclasses implement {@link compile} and
 * {@link capabilities}. The registry in ./index.mjs composes them into a
 * multi-pass compiler.
 */
export class CompilerAdapter {
  constructor(name) {
    this.name = name;
  }

  /** @returns {{name: string, languages: string[], passes: string[], backend: string}} */
  capabilities() {
    throw new B8GError(`adapter ${this.name} did not implement capabilities()`, 'NOT_IMPLEMENTED');
  }

  /**
   * @param {{name: string, language: string, source: Uint8Array, options?: object}} unit
   * @returns {Feedback}
   */
  compile(unit) {
    throw new B8GError(`adapter ${this.name} did not implement compile()`, 'NOT_IMPLEMENTED');
  }

  /** Convenience wrapper that normalises input and records timings. */
  run(name, language, source, options = {}) {
    const unit = {
      name,
      language,
      source: source instanceof Uint8Array ? source : new TextEncoder().encode(String(source)),
      options,
    };
    const start = Date.now();
    const feedback = this.compile(unit);
    feedback.timings.totalMs = Date.now() - start;
    return feedback;
  }
}

export { B8GError };
