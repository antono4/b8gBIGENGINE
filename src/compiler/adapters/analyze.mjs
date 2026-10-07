import { Diagnostic, Remark, Severity } from '../feedback.mjs';

/**
 * A small but real source analyser shared by every adapter.
 *
 * It tokenises the unit and derives facts (counts, hot loops, dynamic-scope
 * hazards, unused bindings). Adapters turn these facts into pass-specific
 * remarks, which is what a compiler feedback interface is for: the facts are
 * measured, the pass narrative is the adapter's interpretation.
 */
export function analyze(source, language) {
  const text = source instanceof Uint8Array ? new TextDecoder().decode(source) : String(source);
  const lines = text.split(/\r?\n/);
  const stripped = stripCommentsAndStrings(text);

  const facts = {
    lines: lines.length,
    bytes: text.length,
    functions: countMatches(stripped, /\bfunction\b|\bdef\b|\bfn\b|=>/g),
    loops: countMatches(stripped, /\bfor\b|\bwhile\b|\bdo\b|\bloop\b/g),
    branches: countMatches(stripped, /\bif\b|\bswitch\b|\bmatch\b|\bcase\b/g),
    calls: countMatches(stripped, /[A-Za-z_$][\w$]*\s*\(/g),
    memoryOps: countMatches(stripped, /\balloc\b|\bmalloc\b|\bnew\b|\bUint8Array\b|\bArrayBuffer\b|\bSharedArrayBuffer\b/g),
    dynamicScope: countMatches(stripped, /\beval\s*\(|\bwith\s*\(|\bnew\s+Function\b/g),
    globals: countMatches(stripped, /\bvar\b|\bglobalThis\b/g),
    asyncOps: countMatches(stripped, /\bawait\b|\basync\b|\bPromise\b/g),
    recursion: detectRecursion(stripped),
    longestLine: lines.reduce((n, l) => Math.max(n, l.length), 0),
    unusedBindings: findUnusedBindings(stripped, language),
  };

  const diagnostics = [];
  const remarks = [];

  if (facts.dynamicScope > 0 && (language === 'ecmascript' || language === 'typescript')) {
    diagnostics.push(
      new Diagnostic({
        severity: Severity.WARNING,
        message: `dynamic scope construct used ${facts.dynamicScope}x (eval/with/Function)`,
        pass: 'frontend',
        hint: 'dynamic scope defeats static optimisation and capability isolation',
      }),
    );
  }
  if (facts.longestLine > 200) {
    diagnostics.push(
      new Diagnostic({
        severity: Severity.NOTE,
        message: `longest line is ${facts.longestLine} columns`,
        pass: 'frontend',
      }),
    );
  }
  for (const binding of facts.unusedBindings) {
    diagnostics.push(
      new Diagnostic({
        severity: Severity.WARNING,
        message: `unused binding "${binding}"`,
        pass: 'frontend',
        hint: 'dead code can be removed before codegen',
      }),
    );
  }
  if (facts.globals > 0) {
    remarks.push(
      new Remark({
        pass: 'frontend',
        message: `${facts.globals} mutable global reference(s) — alias analysis will be conservative`,
        impact: -1,
      }),
    );
  }
  if (facts.loops > 0) {
    remarks.push(
      new Remark({
        pass: 'optimize',
        message: `${facts.loops} loop(s) available for vectorisation`,
        impact: facts.loops,
        suggestion: 'hoist invariants out of the loop nest',
      }),
    );
  }
  if (facts.memoryOps > 0) {
    remarks.push(
      new Remark({
        pass: 'optimize',
        message: `${facts.memoryOps} allocation site(s) detected`,
        impact: facts.memoryOps,
        suggestion: 'reuse regions via the b8g memory pool instead of re-allocating',
      }),
    );
  }
  if (facts.recursion.length) {
    remarks.push(
      new Remark({
        pass: 'optimize',
        message: `self-recursive call(s): ${facts.recursion.join(', ')}`,
        impact: -1,
        suggestion: 'inlining/partial evaluation may break the recursion',
      }),
    );
  }

  return { facts, diagnostics, remarks };
}

function stripCommentsAndStrings(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/#[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, '``');
}

function countMatches(text, re) {
  const m = text.match(re);
  return m ? m.length : 0;
}

function detectRecursion(text) {
  const names = [];
  const re = /(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function|\())/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1] || m[2];
    if (!name) continue;
    const body = extractBody(text, m.index + m[0].length);
    if (body && new RegExp(`\\b${name}\\s*\\(`).test(body)) names.push(name);
  }
  return [...new Set(names)];
}

/** Naive brace-matched body extraction, enough for a feedback heuristic. */
function extractBody(text, from) {
  const open = text.indexOf('{', from);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return null;
}

function findUnusedBindings(text, language) {
  if (language !== 'ecmascript' && language !== 'typescript') return [];
  const declared = [];
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(text))) declared.push(m[1]);
  return declared.filter((name) => {
    const uses = (text.match(new RegExp(`\\b${name}\\b`, 'g')) || []).length;
    return uses <= 1;
  });
}
