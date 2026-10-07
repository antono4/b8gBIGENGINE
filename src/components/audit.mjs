import { Tag, Right } from '../runtime/constants.mjs';
import { CapabilityHandle } from '../runtime/capability.mjs';

/**
 * Audit component.
 *
 * Scans a unit of (usually AI-generated) code for hazards that matter when the
 * code is about to run inside the engine: dynamic scope, unchecked memory
 * allocation, ambient authority (globals), and unbounded loops. It writes a
 * compact JSON record into a shared-memory region it was granted, and emits a
 * summary on its audit stream.
 *
 * It demonstrates the capability model: the component cannot allocate memory
 * or talk to the outside world on its own — it can only use the `heap` and
 * `report` handles it was given.
 */
export const auditComponent = {
  name: 'audit',
  version: '0.1.0',
  requires: ['heap', 'report'],
  provides: ['scan'],
  factory(handles) {
    const heap = handles.heap;
    const report = handles.report;
    let offset = 0;

    function scan(unit) {
      const source = typeof unit.source === 'string' ? unit.source : new TextDecoder().decode(unit.source);
      const findings = [];

      const rules = [
        { id: 'dynamic-scope', re: /\beval\s*\(|\bwith\s*\(|\bnew\s+Function\b/g, severity: 'high', note: 'dynamic scope escapes static analysis' },
        { id: 'ambient-authority', re: /\bglobalThis\b|\bwindow\b|\bprocess\b/g, severity: 'medium', note: 'ambient authority access' },
        { id: 'unbounded-loop', re: /\bwhile\s*\(\s*true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/g, severity: 'high', note: 'unbounded loop, no termination proof' },
        { id: 'raw-alloc', re: /\bmalloc\s*\(|\bnew\s+ArrayBuffer\b|\bnew\s+SharedArrayBuffer\b/g, severity: 'low', note: 'direct allocation, prefer the region pool' },
        { id: 'shell-out', re: /child_process|\bexec\s*\(|\bspawn\s*\(/g, severity: 'high', note: 'process execution requires an explicit capability' },
        { id: 'network', re: /\bfetch\s*\(|XMLHttpRequest|\bnet\.|\bhttp\./g, severity: 'medium', note: 'network access requires an explicit capability' },
      ];

      for (const rule of rules) {
        const matches = source.match(rule.re);
        if (matches) {
          findings.push({ rule: rule.id, severity: rule.severity, count: matches.length, note: rule.note });
        }
      }

      const record = {
        unit: unit.name,
        language: unit.language,
        findings,
        riskScore: findings.reduce((n, f) => n + { low: 1, medium: 3, high: 8 }[f.severity], 0),
        scannedAt: Date.now(),
      };

      const bytes = new TextEncoder().encode(JSON.stringify(record) + '\n');
      heap.require(Right.WRITE, 'audit scan');
      if (offset + bytes.length <= heap.target.size) {
        heap.target.write(offset, bytes);
        offset += bytes.length;
      }
      report.require(Right.WRITE, 'audit report');
      report.target.emit({ type: 'audit', unit: unit.name, riskScore: record.riskScore, findings });

      return record;
    }

    return { scan, describe: () => ({ component: 'audit', writes: offset }) };
  },
};

/** Build an EXEC handle that wraps a callable export. */
export function functionHandle(fn, name, owner = 'kernel') {
  const handle = new CapabilityHandle(Tag.Function, fn, Right.EXEC, { name, owner });
  return handle;
}
