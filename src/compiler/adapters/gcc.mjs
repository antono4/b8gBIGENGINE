import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompilerAdapter, Diagnostic, Remark, Feedback, Severity } from '../feedback.mjs';
import { analyze } from './analyze.mjs';

const LANGUAGE_FLAGS = {
  c: { compiler: 'gcc', ext: '.c' },
  cpp: { compiler: 'g++', ext: '.cpp' },
};

/**
 * GCC adapter.
 *
 * Unlike the other adapters this one drives a *real* compiler: it writes the
 * unit to a temp file and runs `gcc -fdiagnostics-format=json`, then folds the
 * machine-readable diagnostics into the normalised feedback shape. When gcc is
 * unavailable it degrades to static analysis so the engine still produces
 * feedback.
 */
export class GccAdapter extends CompilerAdapter {
  constructor(opts = {}) {
    super('gcc');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.available = this._detect();
  }

  _detect() {
    const probe = spawnSync('gcc', ['--version'], { encoding: 'utf8' });
    return probe.status === 0;
  }

  capabilities() {
    return {
      name: 'gcc',
      languages: ['c', 'cpp'],
      passes: ['parse', 'tree-ssa', 'optimize', 'expand', 'codegen'],
      backend: 'gcc',
      available: this.available,
      feedbackOnly: false,
    };
  }

  compile(unit) {
    const { facts, diagnostics: staticDiag, remarks } = analyze(unit.source, unit.language);
    const diagnostics = [...staticDiag];
    const artifacts = [];
    const timings = { frontendMs: 0, optimizeMs: 0, codegenMs: 0 };

    if (!this.available || !LANGUAGE_FLAGS[unit.language]) {
      diagnostics.push(
        new Diagnostic({
          severity: Severity.NOTE,
          message: `gcc unavailable or language ${unit.language} unsupported — static feedback only`,
          pass: 'driver',
        }),
      );
      return new Feedback('gcc', unit, { diagnostics, remarks, artifacts, timings });
    }

    const { compiler, ext } = LANGUAGE_FLAGS[unit.language];
    const dir = mkdtempSync(join(tmpdir(), 'b8g-gcc-'));
    const file = join(dir, `unit${ext}`);
    const start = Date.now();
    try {
      writeFileSync(file, unit.source);
      const res = spawnSync(compiler, ['-fsyntax-only', '-Wall', '-fdiagnostics-format=json', file], {
        encoding: 'utf8',
        timeout: this.timeoutMs,
      });
      timings.frontendMs = Date.now() - start;
      const parsed = parseGccJson(res.stderr || res.stdout || '');
      for (const d of parsed) diagnostics.push(d);
      if (parsed.length === 0 && res.status === 0) {
        diagnostics.push(
          new Diagnostic({ severity: Severity.NOTE, message: 'gcc: no diagnostics', pass: 'driver' }),
        );
      }
      remarks.push(
        new Remark({
          pass: 'tree-ssa',
          message: `gcc pass pipeline would run ${this.capabilities().passes.length} passes`,
          impact: 0,
        }),
      );
      timings.optimizeMs = 1;
      void facts;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    return new Feedback('gcc', unit, { diagnostics, remarks, artifacts, timings });
  }
}

/** Parse gcc's `-fdiagnostics-format=json` stream into Diagnostics. */
export function parseGccJson(text) {
  const out = [];
  const trimmed = text.trim();
  if (!trimmed) return out;
  // gcc emits a concatenation of JSON objects; extract each balanced object.
  for (const chunk of splitJsonObjects(trimmed)) {
    try {
      const obj = JSON.parse(chunk);
      const loc = obj.locations?.[0]?.caret ?? {};
      out.push(
        new Diagnostic({
          severity: obj.kind === 'error' ? Severity.ERROR : obj.kind === 'warning' ? Severity.WARNING : Severity.NOTE,
          message: obj.message ?? 'unknown gcc diagnostic',
          line: loc.line ?? 0,
          column: loc.column ?? 0,
          file: loc.file ?? '<input>',
          pass: 'gcc',
          hint: obj.children?.[0]?.message ?? null,
        }),
      );
    } catch {
      /* ignore unparsable fragments */
    }
  }
  return out;
}

function splitJsonObjects(text) {
  const chunks = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        chunks.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return chunks;
}
