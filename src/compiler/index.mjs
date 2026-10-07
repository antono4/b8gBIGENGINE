import { LlvmAdapter } from './adapters/llvm.mjs';
import { GccAdapter } from './adapters/gcc.mjs';
import { V8Adapter } from './adapters/v8.mjs';
import { GraalVmAdapter } from './adapters/graalvm.mjs';
import { B8GError } from '../runtime/errors.mjs';
import { Diagnostic, Severity } from './feedback.mjs';

/**
 * The multi-pass compiler: the b8g "Universal Compiler Feedback Interface".
 *
 * It holds a registry of adapters and, for a given unit, selects a *pipeline*
 * of adapters whose languages cover the unit. Each pass is a separate adapter
 * run; the engine merges the diagnostics/remarks and returns one feedback
 * document. This is the component an AI codegen loop (or a human) reads to
 * decide what to change next.
 */
export class MultiPassCompiler {
  constructor(adapters = []) {
    /** @type {Map<string, import('./feedback.mjs').CompilerAdapter>} */
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  /** A compiler with all four reference adapters pre-registered. */
  static standard(opts = {}) {
    return new MultiPassCompiler([
      new LlvmAdapter(opts.llvm),
      new GccAdapter(opts.gcc),
      new V8Adapter(opts.v8),
      new GraalVmAdapter(opts.graalvm),
    ]);
  }

  register(adapter) {
    this.adapters.set(adapter.name, adapter);
    return adapter;
  }

  get(name) {
    const adapter = this.adapters.get(name);
    if (!adapter) throw new B8GError(`unknown compiler adapter ${name}`, 'NO_ADAPTER');
    return adapter;
  }

  list() {
    return [...this.adapters.values()].map((a) => a.capabilities());
  }

  /** Pick the adapter pipeline whose languages cover `language`. */
  plan(language) {
    const lang = String(language).toLowerCase();
    return [...this.adapters.values()]
      .filter((a) => a.capabilities().languages.includes(lang))
      .map((a) => a.name);
  }

  /**
   * Compile a unit through a pipeline of adapters.
   *
   * @param {{name?: string, language: string, source: string|Uint8Array, adapters?: string[]}} unit
   */
  compile(unit) {
    if (!unit?.language) throw new B8GError('compile requires a language', 'BAD_UNIT');
    const pipeline = unit.adapters ?? this.plan(unit.language);
    if (!pipeline.length) {
      throw new B8GError(`no adapter supports language ${unit.language}`, 'NO_ADAPTER', {
        available: this.list().map((c) => c.name),
      });
    }

    const name = unit.name ?? 'unit';
    const passes = pipeline.map((adapterName) => {
      const adapter = this.get(adapterName);
      const feedback = adapter.run(name, unit.language, unit.source, unit.options);
      return { adapter: adapterName, feedback };
    });

    const diagnostics = dedupe(
      passes.flatMap((p) => p.feedback.diagnostics),
      (d) => `${d.severity}|${d.pass}|${d.message}`,
    );
    const remarks = dedupe(
      passes.flatMap((p) => p.feedback.remarks),
      (r) => `${r.pass}|${r.message}`,
    );
    const artifacts = passes.flatMap((p) => p.feedback.artifacts);
    const ok = passes.every((p) => p.feedback.ok);

    if (!ok) {
      diagnostics.push(
        new Diagnostic({
          severity: Severity.FATAL,
          message: `pipeline [${pipeline.join(' -> ')}] failed`,
          pass: 'driver',
        }),
      );
    }

    return {
      unit: { name, language: unit.language },
      pipeline,
      ok,
      passes: passes.map((p) => p.feedback.toJSON()),
      diagnostics: diagnostics.map((d) => d.toJSON()),
      remarks: remarks.map((r) => r.toJSON()),
      artifacts: artifacts.map((a) => ({ name: a.name, kind: a.kind, bytes: a.bytes })),
      summary: {
        passes: pipeline.length,
        errors: diagnostics.filter((d) => d.severity === Severity.ERROR || d.severity === Severity.FATAL).length,
        warnings: diagnostics.filter((d) => d.severity === Severity.WARNING).length,
        remarks: remarks.length,
      },
    };
  }
}

function dedupe(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
