import { CompilerAdapter, Diagnostic, Remark, Feedback, Severity } from '../feedback.mjs';
import { analyze } from './analyze.mjs';

/**
 * Node builtins are loaded through `process.getBuiltinModule` rather than a
 * static `node:` import, so this module also loads in a browser (where it
 * simply reports the compiler as unavailable). See ./node-tools.mjs.
 */
import { nodeTools } from './node-tools.mjs';

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
 * unavailable (or we are not running under Node) it degrades to static
 * analysis so the engine still produces feedback.
 */
export class GccAdapter extends CompilerAdapter {
  constructor(opts = {}) {
    super('gcc');
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.tools = nodeTools();
    this.available = this._detect();
  }

  _detect() {
    if (!this.tools) return false;
    const probe = this.tools.spawnSync('gcc', ['--version'], { encoding: 'utf8' });
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
    const dir = this.tools.mkdtempSync(this.tools.join(this.tools.tmpdir(), 'b8g-gcc-'));
    const file = this.tools.join(dir, `unit${ext}`);
    const start = Date.now();
    try {
      this.tools.writeFileSync(file, unit.source);
      const res = this.tools.spawnSync(compiler, ['-fsyntax-only', '-Wall', '-fdiagnostics-format=json', file], {
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
      this.tools.rmSync(dir, { recursive: true, force: true });
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
