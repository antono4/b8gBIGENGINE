import { CompilerAdapter, Diagnostic, Remark, Feedback, Severity } from '../feedback.mjs';
import { analyze } from './analyze.mjs';

/**
 * LLVM adapter.
 *
 * Frontend + optimiser feedback pass. It analyses the unit, reports the
 * LLVM-style pass pipeline it would run and emits a deterministic `.ll`-shaped
 * artifact. It performs no codegen itself — that is the point of a *feedback*
 * interface: the engine consumes the remarks, not the object file.
 */
export class LlvmAdapter extends CompilerAdapter {
  constructor(opts = {}) {
    super('llvm');
    this.targetTriple = opts.targetTriple ?? 'x86_64-unknown-linux-gnu';
    this.pipeline = opts.pipeline ?? ['mem2reg', 'instcombine', 'loop-rotate', 'gvn', 'licm', 'vectorize'];
  }

  capabilities() {
    return {
      name: 'llvm',
      languages: ['c', 'cpp', 'rust', 'llvm-ir'],
      passes: this.pipeline,
      backend: `llvm/${this.targetTriple}`,
      available: true,
      feedbackOnly: true,
    };
  }

  compile(unit) {
    const { facts, diagnostics, remarks } = analyze(unit.source, unit.language);
    const diagnosticsOut = [...diagnostics];
    const remarksOut = [...remarks];

    remarksOut.push(
      new Remark({
        pass: 'mem2reg',
        message: `${facts.functions} function(s) eligible for SSA promotion`,
        impact: facts.functions,
      }),
    );
    if (facts.loops > 1) {
      remarksOut.push(
        new Remark({
          pass: 'licm',
          message: 'loop-invariant code motion can hoist region loads',
          impact: 1,
          suggestion: 'mark loop-carried handles read-only to enable hoisting',
        }),
      );
    }
    if (facts.branches > 8) {
      remarksOut.push(
        new Remark({
          pass: 'instcombine',
          message: `${facts.branches} branches — consider computed dispatch`,
          impact: 0,
        }),
      );
    }
    if (facts.recursion.length) {
      diagnosticsOut.push(
        new Diagnostic({
          severity: Severity.REMARK,
          message: `recursive function(s) block full inlining: ${facts.recursion.join(', ')}`,
          pass: 'inline',
        }),
      );
    }

    const ir = this._emitIr(unit.name, facts);
    return new Feedback('llvm', unit, {
      diagnostics: diagnosticsOut,
      remarks: remarksOut,
      artifacts: [{ name: `${unit.name}.ll`, kind: 'llvm-ir', bytes: new TextEncoder().encode(ir) }],
      timings: { frontendMs: 1, optimizeMs: Math.max(1, facts.loops + facts.functions) },
    });
  }

  _emitIr(name, facts) {
    const id = name.replace(/[^\w]/g, '_');
    return [
      `; ModuleID = '${name}'`,
      `target triple = "${this.targetTriple}"`,
      '',
      `define i64 @${id}(i64 %a, i64 %b) {`,
      'entry:',
      '  %r = add i64 %a, %b',
      ...(facts.loops ? ['  br label %loop', 'loop:', '  br label %loop'] : []),
      '  ret i64 %r',
      '}',
      '',
      `; feedback: ${facts.functions} fns, ${facts.loops} loops, ${facts.memoryOps} allocs`,
    ].join('\n');
  }
}
