import { spawnSync } from 'node:child_process';
import { CompilerAdapter, Diagnostic, Remark, Feedback, Severity } from '../feedback.mjs';
import { analyze } from './analyze.mjs';

/**
 * GraalVM adapter.
 *
 * Models the GraalVM/JVMCI path. If a JVM is present it can report the
 * available version; otherwise it produces a deterministic feedback pass that
 * mirrors the Graal compiler phases (parse, inline, partial-escape, codegen).
 * This is the "incremental adoption" lane from the b8g README: heavier, but
 * it unlocks the whole GraalVM ecosystem when you need it.
 */
export class GraalVmAdapter extends CompilerAdapter {
  constructor(opts = {}) {
    super('graalvm');
    this.javaVersion = opts.javaVersion ?? detectJavaVersion();
    this.available = this.javaVersion !== null;
  }

  capabilities() {
    return {
      name: 'graalvm',
      languages: ['java', 'kotlin', 'scala', 'groovy', 'ecmascript'],
      passes: ['parse', 'inline', 'partial-escape-analysis', 'canonicalize', 'codegen'],
      backend: this.available ? `graalvm/${this.javaVersion}` : 'graalvm/modeled',
      available: this.available,
      feedbackOnly: true,
    };
  }

  compile(unit) {
    const { facts, diagnostics, remarks } = analyze(unit.source, unit.language);
    const diagnosticsOut = [...diagnostics];
    const remarksOut = [...remarks];

    remarksOut.push(
      new Remark({
        pass: 'inline',
        message: `${facts.functions} method(s) candidates for inlining (Graal inline budget)`,
        impact: facts.functions,
      }),
    );
    if (facts.memoryOps > 0) {
      remarksOut.push(
        new Remark({
          pass: 'partial-escape-analysis',
          message: `${facts.memoryOps} allocation(s) may be partially escape-analysable`,
          impact: facts.memoryOps,
          suggestion: 'prefer stack-allocatable region handles',
        }),
      );
    }
    if (facts.asyncOps > 0) {
      diagnosticsOut.push(
        new Diagnostic({
          severity: Severity.REMARK,
          message: `${facts.asyncOps} async site(s) — JVM continuation/loom path may apply`,
          pass: 'canonicalize',
        }),
      );
    }
    if (!this.available) {
      diagnosticsOut.push(
        new Diagnostic({
          severity: Severity.NOTE,
          message: 'no JVM detected — GraalVM feedback is modelled, not measured',
          pass: 'driver',
        }),
      );
    }

    const artifact = [
      `// graalvm native-image feedback for ${unit.name}`,
      `// version: ${this.javaVersion ?? 'n/a'}`,
      `H:${facts.functions}:${facts.loops}:${facts.branches}`,
    ].join('\n');

    return new Feedback('graalvm', unit, {
      diagnostics: diagnosticsOut,
      remarks: remarksOut,
      artifacts: [{ name: `${unit.name}.graal`, kind: 'graal-feedback', bytes: new TextEncoder().encode(artifact) }],
      timings: { frontendMs: 1, optimizeMs: Math.max(1, facts.functions) },
    });
  }
}

function detectJavaVersion() {
  try {
    const res = spawnJavaVersion();
    if (!res) return null;
    const m = res.match(/version "?([\d.]+)/);
    return m ? m[1] : res.split('\n')[0].trim();
  } catch {
    return null;
  }
}

function spawnJavaVersion() {
  const res = spawnSync('java', ['-version'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  return res.stderr || res.stdout || '';
}
